export const SUPERVISOR_NODE_SCRIPT = [
  'const { spawn } = require("node:child_process")',
  'const [packageSpec, dshCommand, resolverScript, ...dshArgs] = process.argv.slice(1)',
  'const [major, minor] = process.versions.node.split(".").map(Number)',
  'if (!((major === 22 && minor >= 19) || major >= 24)) { console.error(`dsh-orcana: unsupported WSL Node ${process.versions.node}; need ^22.19.0 || >=24.0.0`); process.exit(126) }',
  'const command = dshCommand || "/bin/sh"',
  'const args = dshCommand ? dshArgs : ["-lc", resolverScript, "dsh-orcana", packageSpec, ...dshArgs]',
  'const child = spawn(command, args, { detached: true, stdio: "inherit", env: process.env })',
  'let finished = false',
  'const signalGroup = (signal) => { if (child.pid === undefined) return; try { process.kill(-child.pid, signal) } catch (error) { if (!error || error.code !== "ESRCH") throw error } }',
  'const onInt = () => signalGroup("SIGINT")',
  'const onTerm = () => signalGroup("SIGTERM")',
  'const onHup = () => signalGroup("SIGHUP")',
  'process.on("SIGINT", onInt); process.on("SIGTERM", onTerm); process.on("SIGHUP", onHup)',
  'process.on("exit", () => { if (!finished) { try { signalGroup("SIGTERM") } catch {} } })',
  'const finish = (code) => { if (finished) return; finished = true; process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); process.off("SIGHUP", onHup); process.exitCode = code }',
  'child.once("error", (error) => { console.error(error && error.message ? error.message : String(error)); finish(127) })',
  'child.once("close", (code, signal) => { if (code !== null) return finish(code); if (signal === "SIGINT") return finish(130); if (signal === "SIGTERM") return finish(143); if (signal === "SIGHUP") return finish(129); return finish(128) })',
].join(';')

function distroPrefix(distro?: string): string[] {
  return distro === undefined ? [] : ['--distribution', distro]
}

/**
 * Build one supervised Windows→WSL DSH launch. The WSL-side Node process owns
 * terminal-facing signal handling while its detached DSH child becomes a
 * Linux process-group/session leader. Task values remain positional argv only.
 */
export function buildWslSupervisedDshArgs(
  linuxCwd: string,
  dshArgs: readonly string[],
  dshPackage: string,
  resolverScript: string,
  distro?: string,
  dshCommand?: string,
): string[] {
  return [
    ...distroPrefix(distro),
    '--cd', linuxCwd,
    '--exec', 'node', '--input-type=commonjs', '-e', SUPERVISOR_NODE_SCRIPT,
    dshPackage,
    dshCommand ?? '',
    resolverScript,
    ...dshArgs,
  ]
}
