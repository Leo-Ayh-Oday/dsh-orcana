import { spawn, spawnSync } from 'node:child_process'

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
const DSH_ROOT_PASSTHROUGH = new Set(['web', 'plugin'])
const DSH_ROOT_HELP_OR_VERSION = new Set(['-h', '--help', '-V', '--version'])

const NODE_CONTRACT_SCRIPT = 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 19) || major >= 24 ? 0 : 1)'

/**
 * Auto-discovered `dsh` is trusted only when it exactly matches the pinned npm
 * package spec. Explicit ORCANA_WSL_DSH_COMMAND is the deliberate escape hatch.
 */
export const DSH_VERSION_CONTRACT_SCRIPT = [
  'const [spec="",actual=""]=process.argv.slice(1)',
  'const at=spec.lastIndexOf("@")',
  'const expected=at>0?spec.slice(at+1):""',
  'const exact=/^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/.test(expected)',
  'process.exit(exact&&actual.trim()===expected?0:1)',
].join(';')

const DSH_RESOLVER_SCRIPT = [
  'package_spec=$1',
  'dsh_contract=$2',
  'shift 2',
  'if command -v dsh >/dev/null 2>&1; then',
  '  installed_version=$(dsh --version 2>/dev/null || true)',
  '  if command -v node >/dev/null 2>&1 && node -e "$dsh_contract" "$package_spec" "$installed_version" >/dev/null 2>&1; then exec dsh "$@"; fi',
  '  printf "%s\\n" "dsh-orcana: installed dsh version ${installed_version:-unknown} does not match pinned ${package_spec}; using npm fallback" >&2',
  'fi',
  'if command -v npx >/dev/null 2>&1; then exec npx --yes "$package_spec" "$@"; fi',
  'printf "%s\\n" "dsh-orcana: no matching dsh executable and npx is unavailable in this Linux execution world" >&2',
  'exit 127',
].join('\n')

const DOCTOR_SCRIPT = [
  'package_spec=$1',
  'node_contract=$2',
  'dsh_contract=$3',
  'fail=0',
  'node_ok=0',
  'printf "kernel: "; uname -sr || fail=1',
  'if command -v node >/dev/null 2>&1; then printf "node: "; node --version; if ! node -e "$node_contract"; then printf "node-contract: UNSUPPORTED (need ^22.19.0 || >=24.0.0)\\n"; fail=1; else printf "node-contract: OK\\n"; node_ok=1; fi; else printf "node: MISSING\\n"; fail=1; fi',
  'if command -v dsh >/dev/null 2>&1; then installed_version=$(dsh --version 2>/dev/null || true); printf "dsh: %s (%s)\\n" "$(command -v dsh)" "${installed_version:-version-unknown}"; if [ "$node_ok" -eq 1 ] && node -e "$dsh_contract" "$package_spec" "$installed_version" >/dev/null 2>&1; then printf "dsh-contract: OK\\n"; elif command -v npx >/dev/null 2>&1; then printf "dsh-contract: MISMATCH; runtime will fall back to npx %s\\n" "$package_spec"; else printf "dsh-contract: MISMATCH and npx unavailable\\n"; fail=1; fi; elif command -v npx >/dev/null 2>&1; then printf "dsh: fallback via npx %s\\n" "$package_spec"; else printf "dsh: MISSING (and npx unavailable)\\n"; fail=1; fi',
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

/**
 * Decide whether `dsh-orcana` should supply its default profile. DSH's own
 * root commands/help/version remain transparent; task-style invocations get
 * the Orcana profile only when the caller did not choose one explicitly.
 */
export function shouldInjectDefaultProfile(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') return true
    if (arg === '--profile' || arg.startsWith('--profile=')) return false
    if (arg === '--patch') {
      i += 1
      continue
    }
    if (arg.startsWith('--patch=') || arg === '--dump-config' || arg === '--dump-default-config') continue
    if (DSH_ROOT_HELP_OR_VERSION.has(arg) || DSH_ROOT_PASSTHROUGH.has(arg)) return false
    // The first token not owned by the DSH launcher starts app/task argv.
    return true
  }
  return true
}

/** Final DSH argv after bridge defaults, preserving DSH root-command semantics. */
export function dshArgsForBridge(options: WslBridgeOptions): string[] {
  if (options.mode === 'install') {
    return ['plugin', '--profile', options.profile, 'add', ...DEFAULT_WSL_BUNDLES]
  }
  if (options.mode === 'doctor') return []
  if (!shouldInjectDefaultProfile(options.dshArgs)) return [...options.dshArgs]
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
 * Ask the selected WSL distro itself to translate an absolute Windows path.
 * This deliberately does not guess `/mnt/c`: custom automount roots remain
 * correct.
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
  if (!linuxPath.startsWith('/')) throw new Error(`WSL returned an invalid Linux path: ${JSON.stringify(linuxPath)}`)
  return { ...(distro !== undefined ? { distro } : {}), linuxPath }
}

/**
 * Windows' host-side CreateProcess cwd is independent from WSL's `--cd`.
 * Avoid using a WSL UNC path as the Win32 cwd; the mapped Linux cwd remains
 * authoritative inside the distro.
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

function windowsArgumentPathToWsl(
  value: string,
  distro?: string,
  run: typeof spawnSync = spawnSync,
): string {
  if (parseWslUncPath(value) !== undefined || /^[A-Za-z]:/.test(value) || value.startsWith('\\\\')) {
    return windowsPathToWsl(value, distro, run).linuxPath
  }
  // Relative Windows paths share the already-mapped cwd; only separators need
  // normalization. Do not rewrite arbitrary task text — this helper is called
  // only for DSH launcher fields whose schema is explicitly path-valued.
  return value.includes('\\') ? value.replaceAll('\\', '/') : value
}

/**
 * Translate only path-valued arguments owned by the pinned DSH launcher. Today
 * that is `--patch` on the root/web command. App/task argv after the first
 * unknown token or `--` is deliberately opaque.
 */
export function translateDshPathArgsForWsl(
  args: readonly string[],
  distro?: string,
  run: typeof spawnSync = spawnSync,
): string[] {
  const output = [...args]
  let mode: 'root' | 'web' = 'root'

  for (let i = 0; i < output.length; i += 1) {
    const arg = output[i]!
    if (arg === '--') break

    if (mode === 'root') {
      if (arg === '--profile') {
        i += 1
        continue
      }
      if (arg.startsWith('--profile=')) continue
      if (arg === '--patch') {
        const value = output[i + 1]
        if (value !== undefined) output[i + 1] = windowsArgumentPathToWsl(value, distro, run)
        i += 1
        continue
      }
      if (arg.startsWith('--patch=')) {
        output[i] = `--patch=${windowsArgumentPathToWsl(arg.slice('--patch='.length), distro, run)}`
        continue
      }
      if (arg === '--dump-config' || arg === '--dump-default-config' || DSH_ROOT_HELP_OR_VERSION.has(arg)) continue
      if (arg === 'web') {
        mode = 'web'
        continue
      }
      // plugin owns pnpm argv; a task/unknown token starts opaque app argv.
      break
    }

    if (arg === '--patch') {
      const value = output[i + 1]
      if (value !== undefined) output[i + 1] = windowsArgumentPathToWsl(value, distro, run)
      i += 1
      continue
    }
    if (arg.startsWith('--patch=')) {
      output[i] = `--patch=${windowsArgumentPathToWsl(arg.slice('--patch='.length), distro, run)}`
      continue
    }
    if (arg === '--dump-config' || arg === '--dump-default-config') continue
    break
  }
  return output
}

/**
 * Build WSL argv without task interpolation. A caller-supplied DSH command is
 * executed directly. Otherwise the resolver rejects a mismatched installed
 * DSH before falling back to the pinned npm package.
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
    '--exec', '/bin/sh', '-lc', DSH_RESOLVER_SCRIPT, 'dsh-orcana', dshPackage, DSH_VERSION_CONTRACT_SCRIPT,
    ...dshArgs,
  ]
}

function wslenvName(entry: string): string {
  const slash = entry.indexOf('/')
  return slash === -1 ? entry : entry.slice(0, slash)
}

function bridgeBlocksWslEnvName(name: string): boolean {
  return NEVER_IMPLICITLY_FORWARD.has(name) || name.startsWith('ORCANA_WSL_')
}

/** Normalize a bridge-owned existing WSLENV row to Win32 → WSL only. */
function winToWslEntry(entry: string): string {
  const name = wslenvName(entry)
  const slash = entry.indexOf('/')
  const flags = slash === -1 ? '' : entry.slice(slash + 1)
  let pathMode = ''
  for (const flag of flags) {
    if (flag === 'p' || flag === 'l') pathMode = flag
  }
  return `${name}/${pathMode}u`
}

/**
 * Use WSLENV instead of putting secrets on the wsl.exe command line. For rows
 * the bridge owns, an existing reverse-only `/w` is corrected to `/u` while
 * current WSL path/list mode (`p`/`l`) is preserved. DSH_HOME/HOME/PATH and
 * ORCANA_WSL_* are removed from this child WSLENV even when globally present.
 */
export function environmentForWsl(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const forward = new Set<string>(DEFAULT_FORWARD_ENV)

  for (const key of Object.keys(env)) {
    const runtimeVar = key.startsWith('DSH_') || (key.startsWith('ORCANA_') && !key.startsWith('ORCANA_WSL_'))
    if (runtimeVar && !NEVER_IMPLICITLY_FORWARD.has(key)) forward.add(key)
  }
  for (const key of (env.ORCANA_WSL_FORWARD_ENV ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !NEVER_IMPLICITLY_FORWARD.has(key)) forward.add(key)
  }

  const merged: string[] = []
  const satisfied = new Set<string>()
  for (const entry of (env.WSLENV ?? '').split(':').filter(Boolean)) {
    const name = wslenvName(entry)
    if (bridgeBlocksWslEnvName(name)) continue
    if (forward.has(name) && env[name] !== undefined) {
      if (satisfied.has(name)) continue
      merged.push(winToWslEntry(entry))
      satisfied.add(name)
      continue
    }
    merged.push(entry)
  }

  for (const key of forward) {
    if (env[key] !== undefined && !satisfied.has(key)) {
      merged.push(`${key}/u`)
      satisfied.add(key)
    }
  }
  return { ...env, ...(merged.length > 0 ? { WSLENV: merged.join(':') } : { WSLENV: '' }) }
}

function exitCodeFromSignal(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return signal === null ? 1 : 128
}

type SignalMode = 'none' | 'posix-relay' | 'posix-terminal' | 'windows-wsl'

function nativeSignalMode(): SignalMode {
  return process.stdin.isTTY === true ? 'posix-terminal' : 'posix-relay'
}

/**
 * Launch the complete DSH process in one Linux execution world. Windows keeps
 * `wsl.exe` as the terminal/cancellation authority. Native POSIX TTY runs also
 * avoid re-sending SIGINT because the foreground process group already gets it.
 */
export async function launchWslBridge(
  rawArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<number> {
  const options = parseWslBridgeArgs(rawArgs, env)
  const dshCommand = env.ORCANA_WSL_DSH_COMMAND?.trim() || undefined
  const dshPackage = env.ORCANA_WSL_DSH_PACKAGE?.trim() || DEFAULT_WSL_DSH_PACKAGE

  if (process.platform !== 'win32') {
    const signalMode = nativeSignalMode()
    if (options.mode === 'doctor') {
      return await spawnAndWait('/bin/sh', [
        '-lc', DOCTOR_SCRIPT, 'dsh-orcana-doctor', dshPackage, NODE_CONTRACT_SCRIPT, DSH_VERSION_CONTRACT_SCRIPT,
      ], { env, cwd, signalMode })
    }
    const dshArgs = dshArgsForBridge(options)
    if (dshCommand !== undefined) {
      return await spawnAndWait(dshCommand, dshArgs, { env, cwd, signalMode })
    }
    return await spawnAndWait('/bin/sh', [
      '-lc', DSH_RESOLVER_SCRIPT, 'dsh-orcana', dshPackage, DSH_VERSION_CONTRACT_SCRIPT, ...dshArgs,
    ], { env, cwd, signalMode })
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
      '--exec', '/bin/sh', '-lc', DOCTOR_SCRIPT, 'dsh-orcana-doctor',
      dshPackage, NODE_CONTRACT_SCRIPT, DSH_VERSION_CONTRACT_SCRIPT,
    ]
    return await spawnAndWait('wsl.exe', args, { env: childEnv, cwd: hostCwd, signalMode: 'none' })
  }

  const dshArgs = translateDshPathArgsForWsl(dshArgsForBridge(options), distro)
  const args = buildWslDshArgs(mapped.linuxPath, dshArgs, distro, dshCommand, dshPackage)
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
      if (options.signalMode === 'posix-relay' || options.signalMode === 'posix-terminal') {
        process.off('SIGINT', onSigint)
        process.off('SIGTERM', onSigterm)
      } else if (options.signalMode === 'windows-wsl') {
        process.off('SIGINT', onSigint)
        process.off('SIGBREAK', onSigbreak)
      }
      resolve(code)
    }

    const onSigint = () => {
      if (options.signalMode === 'posix-relay') {
        try { child.kill('SIGINT') } catch { /* process already gone */ }
      }
      // Interactive POSIX terminals already signal the foreground group.
      // Windows broadcasts Ctrl+C to wsl.exe, whose native handler owns WSL
      // cancellation. In both cases this parent listener only prevents an
      // early launcher exit while the real child reports status.
    }

    const onSigterm = () => {
      if (options.signalMode !== 'posix-relay' && options.signalMode !== 'posix-terminal') return
      try { child.kill('SIGTERM') } catch { /* process already gone */ }
    }

    const onSigbreak = () => {
      // Windows Ctrl+Break follows the same ownership rule as Ctrl+C: keep the
      // host Node alive and leave translation to wsl.exe.
    }

    if (options.signalMode === 'posix-relay' || options.signalMode === 'posix-terminal') {
      process.on('SIGINT', onSigint)
      process.on('SIGTERM', onSigterm)
    } else if (options.signalMode === 'windows-wsl') {
      process.on('SIGINT', onSigint)
      process.on('SIGBREAK', onSigbreak)
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
