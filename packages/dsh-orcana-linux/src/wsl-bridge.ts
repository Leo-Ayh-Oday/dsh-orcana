import { spawn, spawnSync } from 'node:child_process'
import { buildWslSupervisedDshArgs } from './wsl-supervisor.js'

export const DEFAULT_WSL_PROFILE = 'orcana'
export const DEFAULT_WSL_DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.5'
export const DEFAULT_WSL_BUNDLES = Object.freeze([
  '@leooday/dsh-bundle',
  '@leooday/dsh-orcana-linux-bundle',
] as const)

const DEFAULT_FORWARD_ENV = Object.freeze([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const)

const NEVER_IMPLICITLY_FORWARD = new Set(['DSH_HOME', 'HOME', 'PATH', 'Path'])

const NODE_CONTRACT_SCRIPT = 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 19) || major >= 24 ? 0 : 1)'

const DSH_RESOLVER_SCRIPT = [
  'package_spec=$1',
  'shift',
  'if command -v dsh >/dev/null 2>&1; then exec dsh "$@"; fi',
  'if command -v npx >/dev/null 2>&1; then exec npx --yes "$package_spec" "$@"; fi',
  'printf "%s\\n" "dsh-orcana: neither dsh nor npx is available in this Linux execution world" >&2',
  'exit 127',
].join('\n')

const DOCTOR_SCRIPT = [
  'package_spec=$1',
  'node_contract=$2',
  'fail=0',
  'printf "kernel: "; uname -sr || fail=1',
  'if command -v node >/dev/null 2>&1; then printf "node: "; node --version; if ! node -e "$node_contract"; then printf "node-contract: UNSUPPORTED (need ^22.19.0 || >=24.0.0)\\n"; fail=1; else printf "node-contract: OK\\n"; fi; else printf "node: MISSING\\n"; fail=1; fi',
  'if command -v dsh >/dev/null 2>&1; then printf "dsh: "; command -v dsh; elif command -v npx >/dev/null 2>&1; then printf "dsh: fallback via npx %s\\n" "$package_spec"; else printf "dsh: MISSING (and npx unavailable)\\n"; fail=1; fi',
  'for x in bwrap prlimit; do if command -v "$x" >/dev/null 2>&1; then printf "%s: " "$x"; command -v "$x"; else printf "%s: MISSING\\n" "$x"; fi; done',
  'exit "$fail"',
].join('; ')

export interface WslBridgeOptions {
  distro?: string
  profile: string
  mode: 'run' | 'install' | 'doctor'
  dshArgs: string[]
}

export interface WslUncPath {
  distro: string
  linuxPath: string
}

/**
 * Parse only bridge-owned `--wsl-*` flags before the first `--`. The sentinel
 * itself and every argument after it are preserved byte-for-byte for DSH.
 */
export function parseWslBridgeArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): WslBridgeOptions {
  let distro = env.ORCANA_WSL_DISTRO?.trim() || undefined
  let profile = env.ORCANA_WSL_PROFILE?.trim() || DEFAULT_WSL_PROFILE
  let mode: WslBridgeOptions['mode'] = 'run'
  const dshArgs: string[] = []
  let passthrough = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (passthrough) {
      dshArgs.push(arg)
      continue
    }
    if (arg === '--') {
      dshArgs.push(arg)
      passthrough = true
      continue
    }
    if (arg === '--wsl-install') {
      if (mode !== 'run') throw new Error('only one of --wsl-install / --wsl-doctor may be used')
      mode = 'install'
      continue
    }
    if (arg === '--wsl-doctor') {
      if (mode !== 'run') throw new Error('only one of --wsl-install / --wsl-doctor may be used')
      mode = 'doctor'
      continue
    }
    if (arg === '--wsl-distro' || arg === '--wsl-profile') {
      const value = args[i + 1]
      if (value === undefined || value.length === 0) throw new Error(`${arg} requires a value`)
      if (arg === '--wsl-distro') distro = value
      else profile = value
      i += 1
      continue
    }
    if (arg.startsWith('--wsl-distro=')) {
      distro = arg.slice('--wsl-distro='.length)
      if (!distro) throw new Error('--wsl-distro requires a value')
      continue
    }
    if (arg.startsWith('--wsl-profile=')) {
      profile = arg.slice('--wsl-profile='.length)
      if (!profile) throw new Error('--wsl-profile requires a value')
      continue
    }
    dshArgs.push(arg)
  }

  return { ...(distro !== undefined ? { distro } : {}), profile, mode, dshArgs }
}

export function hasDshProfileArg(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false
    if (arg === '--profile' || arg.startsWith('--profile=')) return true
  }
  return false
}

/** Final DSH argv after bridge defaults. Explicit pre-sentinel DSH --profile wins. */
export function dshArgsForBridge(options: WslBridgeOptions): string[] {
  if (options.mode === 'install') {
    return ['plugin', '--profile', options.profile, 'add', ...DEFAULT_WSL_BUNDLES]
  }
  if (options.mode === 'doctor') return []
  if (hasDshProfileArg(options.dshArgs)) return [...options.dshArgs]
  return ['--profile', options.profile, ...options.dshArgs]
}

/**
 * Decode a Windows WSL UNC path without starting a subprocess.
 * Supports both modern \\wsl.localhost\Distro\... and legacy \\wsl$\Distro\....
 */
export function parseWslUncPath(input: string): WslUncPath | undefined {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i.exec(input)
  if (match === null) return undefined
  const distro = match[1]!
  const rest = (match[2] ?? '').split('\\').filter(Boolean).join('/')
  return { distro, linuxPath: rest.length === 0 ? '/' : `/${rest}` }
}

function distroPrefix(distro?: string): string[] {
  return distro === undefined ? [] : ['--distribution', distro]
}

/**
 * Ask the selected WSL distro itself to translate cwd. This deliberately does
 * not guess `/mnt/c`: custom automount roots remain correct.
 */
export function windowsPathToWsl(
  windowsPath: string,
  distro?: string,
  run: typeof spawnSync = spawnSync,
): { distro?: string; linuxPath: string } {
  const unc = parseWslUncPath(windowsPath)
  if (unc !== undefined) {
    if (distro !== undefined && distro.toLowerCase() !== unc.distro.toLowerCase()) {
      throw new Error(`cwd belongs to WSL distro '${unc.distro}' but --wsl-distro selected '${distro}'`)
    }
    return { distro: distro ?? unc.distro, linuxPath: unc.linuxPath }
  }

  const result = run(
    'wsl.exe',
    [...distroPrefix(distro), '--exec', 'wslpath', '-a', '-u', windowsPath],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new Error('WSL is not installed or wsl.exe is not on PATH')
    throw result.error
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim()
    throw new Error(`WSL path translation failed${stderr ? `: ${stderr}` : ''}`)
  }
  const linuxPath = String(result.stdout ?? '').trim()
  if (!linuxPath.startsWith('/')) throw new Error(`WSL returned an invalid Linux cwd: ${JSON.stringify(linuxPath)}`)
  return { ...(distro !== undefined ? { distro } : {}), linuxPath }
}

/**
 * Windows' host-side CreateProcess cwd is independent from WSL's `--cd`.
 * Avoid using a WSL UNC path as the Win32 cwd; the mapped Linux cwd is still
 * passed through `--cd` and remains authoritative inside the distro.
 */
export function hostCwdForWslSpawn(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (parseWslUncPath(cwd) === undefined) return cwd
  return env.USERPROFILE ?? env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\'
}

export type WindowsWorkspaceKind = 'wsl-native' | 'windows-mounted'

export function windowsWorkspaceKind(cwd: string): WindowsWorkspaceKind {
  return parseWslUncPath(cwd) === undefined ? 'windows-mounted' : 'wsl-native'
}

/**
 * Build an unsupervised WSL argv. Kept as a public pure helper for embedders;
 * the Windows CLI path uses buildWslSupervisedDshArgs instead.
 */
export function buildWslDshArgs(
  linuxCwd: string,
  dshArgs: readonly string[],
  distro?: string,
  dshCommand?: string,
  dshPackage = DEFAULT_WSL_DSH_PACKAGE,
): string[] {
  if (dshCommand !== undefined && dshCommand.length > 0) {
    return [
      ...distroPrefix(distro),
      '--cd', linuxCwd,
      '--exec', dshCommand,
      ...dshArgs,
    ]
  }
  return [
    ...distroPrefix(distro),
    '--cd', linuxCwd,
    '--exec', '/bin/sh', '-lc', DSH_RESOLVER_SCRIPT, 'dsh-orcana', dshPackage,
    ...dshArgs,
  ]
}

function wslenvName(entry: string): string {
  const slash = entry.indexOf('/')
  return slash === -1 ? entry : entry.slice(0, slash)
}

/**
 * Use WSLENV instead of putting secrets on the wsl.exe command line. Existing
 * WSLENV entries are preserved. DSH_HOME is intentionally excluded because a
 * Windows profile may contain Windows-native node_modules; WSL owns its own
 * DSH home and package graph. Bridge-control `ORCANA_WSL_*` variables stay on
 * the host. Entries added by this bridge use `/u`, so they flow only from
 * Win32 into WSL and do not implicitly flow back into Win32 children.
 */
export function environmentForWsl(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const existing = (env.WSLENV ?? '').split(':').filter(Boolean)
  const names = new Set(existing.map(wslenvName))
  const forward = new Set<string>(DEFAULT_FORWARD_ENV)

  for (const key of Object.keys(env)) {
    const runtimeVar = key.startsWith('DSH_') || (key.startsWith('ORCANA_') && !key.startsWith('ORCANA_WSL_'))
    if (runtimeVar && !NEVER_IMPLICITLY_FORWARD.has(key)) forward.add(key)
  }
  for (const key of (env.ORCANA_WSL_FORWARD_ENV ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !NEVER_IMPLICITLY_FORWARD.has(key)) forward.add(key)
  }

  const merged = [...existing]
  for (const key of forward) {
    if (env[key] !== undefined && !names.has(key)) {
      merged.push(`${key}/u`)
      names.add(key)
    }
  }
  return { ...env, ...(merged.length > 0 ? { WSLENV: merged.join(':') } : {}) }
}

function exitCodeFromSignal(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return signal === null ? 1 : 128
}

type SignalMode = 'none' | 'posix' | 'windows-wsl'

/**
 * Launch the complete DSH process in one Linux execution world. On Windows,
 * Ctrl+C stays on WSL's native console-cancellation path. The host Node keeps
 * itself alive while the WSL-side supervisor relays the resulting Linux
 * signal to the detached DSH process group.
 */
export async function launchWslBridge(
  rawArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<number> {
  const options = parseWslBridgeArgs(rawArgs, env)
  const dshCommand = env.ORCANA_WSL_DSH_COMMAND?.trim() || undefined
  const dshPackage = env.ORCANA_WSL_DSH_PACKAGE?.trim() || DEFAULT_WSL_DSH_PACKAGE

  // The same entrypoint remains useful from inside WSL/native Linux: no nested
  // WSL, just run DSH with the identical profile/install semantics.
  if (process.platform !== 'win32') {
    if (options.mode === 'doctor') {
      return await spawnAndWait('/bin/sh', ['-lc', DOCTOR_SCRIPT, 'dsh-orcana-doctor', dshPackage, NODE_CONTRACT_SCRIPT], {
        env,
        cwd,
        signalMode: 'posix',
      })
    }
    const dshArgs = dshArgsForBridge(options)
    if (dshCommand !== undefined) {
      return await spawnAndWait(dshCommand, dshArgs, { env, cwd, signalMode: 'posix' })
    }
    return await spawnAndWait('/bin/sh', ['-lc', DSH_RESOLVER_SCRIPT, 'dsh-orcana', dshPackage, ...dshArgs], {
      env,
      cwd,
      signalMode: 'posix',
    })
  }

  const mapped = windowsPathToWsl(cwd, options.distro)
  const distro = options.distro ?? mapped.distro
  const childEnv = environmentForWsl(env)
  const hostCwd = hostCwdForWslSpawn(cwd, env)

  if (options.mode === 'doctor') {
    const kind = windowsWorkspaceKind(cwd)
    if (kind === 'wsl-native') {
      console.error('[orcana-wsl] workspace: WSL-native filesystem (fast path)')
    } else {
      console.error('[orcana-wsl] workspace: Windows filesystem mounted into WSL (compatible; WSL-native project storage is faster for Linux-heavy I/O)')
    }
    const args = [
      ...distroPrefix(distro),
      '--cd', mapped.linuxPath,
      '--exec', '/bin/sh', '-lc', DOCTOR_SCRIPT, 'dsh-orcana-doctor', dshPackage, NODE_CONTRACT_SCRIPT,
    ]
    return await spawnAndWait('wsl.exe', args, { env: childEnv, cwd: hostCwd, signalMode: 'none' })
  }

  const args = buildWslSupervisedDshArgs(
    mapped.linuxPath,
    dshArgsForBridge(options),
    dshPackage,
    DSH_RESOLVER_SCRIPT,
    distro,
    dshCommand,
  )
  return await spawnAndWait('wsl.exe', args, {
    env: childEnv,
    cwd: hostCwd,
    signalMode: 'windows-wsl',
  })
}

async function spawnAndWait(
  command: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv
    cwd: string
    signalMode: SignalMode
  },
): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      windowsHide: false,
    })
    let settled = false

    const finish = (code: number) => {
      if (settled) return
      settled = true
      if (options.signalMode === 'posix') {
        process.off('SIGINT', onSigint)
        process.off('SIGTERM', onSigterm)
      } else if (options.signalMode === 'windows-wsl') {
        process.off('SIGINT', onSigint)
      }
      resolve(code)
    }

    const onSigint = () => {
      if (options.signalMode === 'posix') {
        try { child.kill('SIGINT') } catch { /* process already gone */ }
        return
      }
      // On Windows the console event is broadcast to both this launcher and
      // wsl.exe. Keeping a listener prevents this Node parent from exiting;
      // wsl.exe's own Ctrl+C handler remains the single cancellation authority.
    }

    const onSigterm = () => {
      if (options.signalMode !== 'posix') return
      try { child.kill('SIGTERM') } catch { /* process already gone */ }
    }

    if (options.signalMode === 'posix') {
      process.on('SIGINT', onSigint)
      process.on('SIGTERM', onSigterm)
    } else if (options.signalMode === 'windows-wsl') {
      process.on('SIGINT', onSigint)
    }

    child.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error(`${command} was not found`)
      } else {
        console.error(error instanceof Error ? error.message : String(error))
      }
      finish(127)
    })
    child.once('close', (code, signal) => finish(code ?? exitCodeFromSignal(signal)))
  })
}
