import { spawn, spawnSync } from 'node:child_process'

export const DEFAULT_WSL_PROFILE = 'orcana'
export const DEFAULT_WSL_BUNDLES = Object.freeze([
  '@leooday/dsh-bundle',
  '@leooday/dsh-orcana-linux-bundle',
] as const)

const DEFAULT_FORWARD_ENV = Object.freeze([
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const)

const NEVER_IMPLICITLY_FORWARD = new Set(['DSH_HOME', 'HOME', 'PATH', 'Path'])

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
 * Parse only bridge-owned `--wsl-*` flags. Every other argument is preserved
 * byte-for-byte for DSH, so new DSH CLI flags do not require bridge updates.
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
  return args.some((arg) => arg === '--profile' || arg.startsWith('--profile='))
}

/** Final DSH argv after bridge defaults. Explicit DSH --profile always wins. */
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

/** Build wsl.exe argv without shell interpolation. */
export function buildWslDshArgs(
  linuxCwd: string,
  dshArgs: readonly string[],
  distro?: string,
  dshCommand = 'dsh',
): string[] {
  return [
    ...distroPrefix(distro),
    '--cd', linuxCwd,
    '--exec', dshCommand,
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
 * DSH home and package graph.
 */
export function environmentForWsl(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const existing = (env.WSLENV ?? '').split(':').filter(Boolean)
  const names = new Set(existing.map(wslenvName))
  const forward = new Set<string>(DEFAULT_FORWARD_ENV)

  for (const key of Object.keys(env)) {
    if ((key.startsWith('DSH_') || key.startsWith('ORCANA_')) && !NEVER_IMPLICITLY_FORWARD.has(key)) {
      forward.add(key)
    }
  }
  for (const key of (env.ORCANA_WSL_FORWARD_ENV ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !NEVER_IMPLICITLY_FORWARD.has(key)) forward.add(key)
  }

  const merged = [...existing]
  for (const key of forward) {
    if (env[key] !== undefined && !names.has(key)) {
      merged.push(key)
      names.add(key)
    }
  }
  return { ...env, ...(merged.length > 0 ? { WSLENV: merged.join(':') } : {}) }
}

const DOCTOR_SCRIPT = [
  'printf "kernel: "; uname -sr',
  'for x in node dsh bwrap prlimit; do',
  '  if command -v "$x" >/dev/null 2>&1; then printf "%s: " "$x"; command -v "$x"; else printf "%s: MISSING\\n" "$x"; fi',
  'done',
].join('; ')

function exitCodeFromSignal(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return signal === null ? 1 : 128
}

/**
 * Launch the complete DSH process in one Linux execution world. No task
 * command is shell-quoted or re-parsed: wsl.exe receives DSH argv directly.
 */
export async function launchWslBridge(
  rawArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<number> {
  const options = parseWslBridgeArgs(rawArgs, env)
  const dshCommand = env.ORCANA_WSL_DSH_COMMAND?.trim() || 'dsh'

  // The same entrypoint remains useful from inside WSL/native Linux: no nested
  // WSL, just run DSH with the identical profile/install semantics.
  if (process.platform !== 'win32') {
    const args = options.mode === 'doctor'
      ? ['-lc', DOCTOR_SCRIPT]
      : dshArgsForBridge(options)
    const command = options.mode === 'doctor' ? '/bin/sh' : dshCommand
    return await spawnAndWait(command, args, { env, cwd })
  }

  const mapped = windowsPathToWsl(cwd, options.distro)
  const distro = options.distro ?? mapped.distro
  const childEnv = environmentForWsl(env)

  if (options.mode === 'doctor') {
    const args = [
      ...distroPrefix(distro),
      '--cd', mapped.linuxPath,
      '--exec', '/bin/sh', '-lc', DOCTOR_SCRIPT,
    ]
    return await spawnAndWait('wsl.exe', args, { env: childEnv, cwd })
  }

  const args = buildWslDshArgs(mapped.linuxPath, dshArgsForBridge(options), distro, dshCommand)
  return await spawnAndWait('wsl.exe', args, { env: childEnv, cwd })
}

async function spawnAndWait(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
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
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      resolve(code)
    }
    const onSigint = () => {
      try { child.kill('SIGINT') } catch { /* process already gone */ }
    }
    const onSigterm = () => {
      try { child.kill('SIGTERM') } catch { /* process already gone */ }
    }
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
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
