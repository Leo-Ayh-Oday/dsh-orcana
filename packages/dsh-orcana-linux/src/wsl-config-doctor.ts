import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { hostCwdForWslSpawn } from './wsl-bridge.js'

export const WSL_MANAGED_CONFIG_FILES = Object.freeze([
  'settings.yaml',
  '.credentials.yaml',
] as const)

export type WslManagedConfigFile = typeof WSL_MANAGED_CONFIG_FILES[number]
export type ConfigFileState = 'present' | 'absent' | 'unreadable'

export interface ConfigFileFingerprint {
  state: ConfigFileState
  sha256?: string
  /** POSIX permission bits; present only for the WSL-side probe. */
  mode?: number
}

export type ConfigParityStatus = 'same' | 'different' | 'host-only' | 'wsl-only' | 'absent' | 'unknown'

export interface ConfigParityRow {
  file: WslManagedConfigFile
  status: ConfigParityStatus
  host: ConfigFileFingerprint
  wsl: ConfigFileFingerprint
}

export interface WslManagedConfigSnapshot {
  'settings.yaml': ConfigFileFingerprint
  '.credentials.yaml': ConfigFileFingerprint
}

/**
 * The WSL probe emits only existence, SHA-256 and permission bits. It never
 * prints managed settings or credential values, paths, YAML parse errors, or
 * environment values.
 */
export const WSL_CONFIG_FINGERPRINT_SCRIPT = [
  'const crypto=require("node:crypto"),fs=require("node:fs"),os=require("node:os"),path=require("node:path")',
  'const home=(process.env.DSH_HOME||"").trim()||path.join(os.homedir(),".dsh")',
  'const out={}',
  'for(const name of ["settings.yaml",".credentials.yaml"]){const file=path.join(home,name);try{const value=fs.readFileSync(file);const stat=fs.statSync(file);out[name]={state:"present",sha256:crypto.createHash("sha256").update(value).digest("hex"),mode:stat.mode&0o777}}catch(error){out[name]={state:error&&error.code==="ENOENT"?"absent":"unreadable"}}}',
  'process.stdout.write(JSON.stringify(out))',
].join(';')

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function hostDshHome(env: NodeJS.ProcessEnv, userHome: string): string {
  return env.DSH_HOME?.trim() || join(userHome, '.dsh')
}

export function fingerprintHostManagedConfig(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): WslManagedConfigSnapshot {
  const home = hostDshHome(env, userHome)
  const read = (name: WslManagedConfigFile): ConfigFileFingerprint => {
    const path = join(home, name)
    if (!existsSync(path)) return { state: 'absent' }
    try {
      return { state: 'present', sha256: sha256(readFileSync(path)) }
    } catch {
      return { state: 'unreadable' }
    }
  }
  return {
    'settings.yaml': read('settings.yaml'),
    '.credentials.yaml': read('.credentials.yaml'),
  }
}

function distroPrefix(distro?: string): string[] {
  return distro === undefined ? [] : ['--distribution', distro]
}

export function buildWslConfigFingerprintArgs(distro?: string): string[] {
  return [
    ...distroPrefix(distro),
    '--exec', 'node', '-e', WSL_CONFIG_FINGERPRINT_SCRIPT,
  ]
}

function validFingerprint(value: unknown): value is ConfigFileFingerprint {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  if (row.state !== 'present' && row.state !== 'absent' && row.state !== 'unreadable') return false
  if (row.state === 'present' && (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256))) return false
  if (row.mode !== undefined && (!Number.isInteger(row.mode) || (row.mode as number) < 0 || (row.mode as number) > 0o777)) return false
  return true
}

function parseWslSnapshot(stdout: string): WslManagedConfigSnapshot | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const object = parsed as Record<string, unknown>
  const settings = object['settings.yaml']
  const credentials = object['.credentials.yaml']
  if (!validFingerprint(settings) || !validFingerprint(credentials)) return undefined
  return {
    'settings.yaml': settings,
    '.credentials.yaml': credentials,
  }
}

/**
 * Probe the WSL-native DSH home. Windows DSH_HOME is deliberately NOT passed:
 * the bridge keeps the two runtime homes separate, so this must inspect the
 * Linux user's own `$DSH_HOME`/`~/.dsh`, not reinterpret a Windows path.
 */
export function probeWslManagedConfig(
  env: NodeJS.ProcessEnv = process.env,
  distro?: string,
  cwd = process.cwd(),
  run: typeof spawnSync = spawnSync,
): WslManagedConfigSnapshot | undefined {
  const result = run('wsl.exe', buildWslConfigFingerprintArgs(distro), {
    cwd: hostCwdForWslSpawn(cwd, env),
    env: { ...env, WSLENV: '' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  })
  if (result.error !== undefined || result.status !== 0) return undefined
  return parseWslSnapshot(String(result.stdout ?? ''))
}

export function classifyConfigParity(
  host: ConfigFileFingerprint,
  wsl: ConfigFileFingerprint,
): ConfigParityStatus {
  if (host.state === 'unreadable' || wsl.state === 'unreadable') return 'unknown'
  if (host.state === 'absent' && wsl.state === 'absent') return 'absent'
  if (host.state === 'present' && wsl.state === 'absent') return 'host-only'
  if (host.state === 'absent' && wsl.state === 'present') return 'wsl-only'
  if (host.state !== 'present' || wsl.state !== 'present') return 'unknown'
  return host.sha256 === wsl.sha256 ? 'same' : 'different'
}

export function managedConfigParityRows(
  host: WslManagedConfigSnapshot,
  wsl: WslManagedConfigSnapshot,
): ConfigParityRow[] {
  return WSL_MANAGED_CONFIG_FILES.map(file => ({
    file,
    status: classifyConfigParity(host[file], wsl[file]),
    host: host[file],
    wsl: wsl[file],
  }))
}

/**
 * Read-only config parity diagnostics. Differences are advisory because a user
 * may intentionally keep separate provider settings per execution world. An
 * unsafe WSL credentials-file mode is a hard doctor failure: DSH itself rejects
 * group/other permission bits rather than reading the secret document.
 */
export function reportWslManagedConfigDoctor(
  env: NodeJS.ProcessEnv = process.env,
  distro?: string,
  cwd = process.cwd(),
  run: typeof spawnSync = spawnSync,
  write: (line: string) => void = line => console.error(line),
  userHome = homedir(),
): number {
  const host = fingerprintHostManagedConfig(env, userHome)
  const wsl = probeWslManagedConfig(env, distro, cwd, run)
  if (wsl === undefined) {
    write('[orcana-wsl] config-parity: UNKNOWN (could not fingerprint WSL managed config)')
    return 0
  }

  let hardFailure = 0
  for (const row of managedConfigParityRows(host, wsl)) {
    write(`[orcana-wsl] config-parity: ${row.file} ${row.status}`)
    if (row.file === '.credentials.yaml' && row.wsl.state === 'present'
      && row.wsl.mode !== undefined && (row.wsl.mode & 0o077) !== 0) {
      hardFailure = 73
      write(`[orcana-wsl] config-parity: .credentials.yaml UNSAFE-MODE ${row.wsl.mode.toString(8)} (DSH requires no group/other permission bits; chmod 600 is the normal repair)`)
    }
    if (row.status === 'host-only' || row.status === 'different') {
      write(`[orcana-wsl] config-parity: ${row.file} is intentionally not auto-copied; Windows and WSL keep separate DSH homes`)
    }
  }
  return hardFailure
}
