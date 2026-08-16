import { randomUUID } from 'node:crypto'

export type WslBridgeSignal = 'INT' | 'TERM' | 'KILL'

const SUPERVISOR_NODE_SCRIPT = [
  'const { spawn, spawnSync } = require("node:child_process")',
  'const { chmodSync, mkdirSync, rmSync, writeFileSync } = require("node:fs")',
  'const [runId, packageSpec, dshCommand, resolverScript, ...dshArgs] = process.argv.slice(1)',
  'if (!runId || !/^[a-f0-9]+$/.test(runId)) { console.error("dsh-orcana: invalid bridge run id"); process.exit(64) }',
  'const [major, minor] = process.versions.node.split(".").map(Number)',
  'if (!((major === 22 && minor >= 19) || major >= 24)) { console.error(`dsh-orcana: unsupported WSL Node ${process.versions.node}; need ^22.19.0 || >=24.0.0`); process.exit(126) }',
  'const pkillProbe = spawnSync("pkill", ["--version"], { stdio: "ignore" })',
  'if (pkillProbe.error && pkillProbe.error.code === "ENOENT") { console.error("dsh-orcana: pkill is required for Windows/WSL session control"); process.exit(126) }',
  'const uid = typeof process.getuid === "function" ? process.getuid() : undefined',
  'if (uid === undefined) { console.error("dsh-orcana: Linux uid is unavailable inside WSL"); process.exit(71) }',
  'const runtimeRoot = `/tmp/dsh-orcana-bridge-${uid}`',
  'mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })',
  'try { chmodSync(runtimeRoot, 0o700) } catch {}',
  'const state = `${runtimeRoot}/${runId}.sid`',
  'const command = dshCommand || "/bin/sh"',
  'const args = dshCommand ? dshArgs : ["-lc", resolverScript, "dsh-orcana", packageSpec, ...dshArgs]',
  'const child = spawn(command, args, { detached: true, stdio: "inherit", env: process.env })',
  'writeFileSync(state, `${child.pid}\\n`, { mode: 0o600 })',
  'let finished = false',
  'const cleanup = () => { try { rmSync(state, { force: true }) } catch {} }',
  'const forward = (sig) => { if (child.pid === undefined) return; spawnSync("pkill", [`-${sig}`, "-s", String(child.pid)], { stdio: "ignore" }) }',
  'const onInt = () => forward("INT")',
  'const onTerm = () => forward("TERM")',
  'const onHup = () => forward("HUP")',
  'process.on("SIGINT", onInt); process.on("SIGTERM", onTerm); process.on("SIGHUP", onHup)',
  'const finish = (code) => { if (finished) return; finished = true; cleanup(); process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); process.off("SIGHUP", onHup); process.exitCode = code }',
  'child.once("error", (error) => { console.error(error && error.message ? error.message : String(error)); finish(127) })',
  'child.once("close", (code, signal) => { if (code !== null) return finish(code); if (signal === "SIGINT") return finish(130); if (signal === "SIGTERM") return finish(143); return finish(128) })',
].join(';')

const CONTROL_SCRIPT = [
  'run_id=$1',
  'sig=$2',
  'case "$run_id" in ""|*[!a-f0-9]*) exit 64;; esac',
  'case "$sig" in INT|TERM|KILL) ;; *) exit 64;; esac',
  'uid=$(id -u) || exit 71',
  'state="/tmp/dsh-orcana-bridge-$uid/$run_id.sid"',
  'i=0',
  'while [ ! -s "$state" ] && [ "$i" -lt 20 ]; do sleep 0.05; i=$((i + 1)); done',
  '[ -s "$state" ] || exit 3',
  'IFS= read -r sid < "$state" || exit 3',
  'case "$sid" in ""|*[!0-9]*) exit 65;; esac',
  'pkill "-$sig" -s "$sid"',
].join('\n')

function distroPrefix(distro?: string): string[] {
  return distro === undefined ? [] : ['--distribution', distro]
}

export function createWslBridgeRunId(): string {
  return randomUUID().replaceAll('-', '')
}

/**
 * Build one supervised Windows→WSL DSH launch. The fixed Node supervisor owns
 * state/cleanup while its detached child becomes the Linux session leader.
 * User-controlled task arguments remain positional values only.
 */
export function buildWslSupervisedDshArgs(
  linuxCwd: string,
  runId: string,
  dshArgs: readonly string[],
  dshPackage: string,
  resolverScript: string,
  distro?: string,
  dshCommand?: string,
): string[] {
  return [
    ...distroPrefix(distro),
    '--cd', linuxCwd,
    '--exec', 'node', '-e', SUPERVISOR_NODE_SCRIPT,
    runId,
    dshPackage,
    dshCommand ?? '',
    resolverScript,
    ...dshArgs,
  ]
}

/** Build the short control invocation that sends a real Linux session signal. */
export function buildWslSignalArgs(
  runId: string,
  signal: WslBridgeSignal,
  distro?: string,
): string[] {
  return [
    ...distroPrefix(distro),
    '--exec', '/bin/sh', '-lc', CONTROL_SCRIPT,
    'dsh-orcana-control', runId, signal,
  ]
}
