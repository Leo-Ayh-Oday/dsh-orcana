import { spawnSync } from 'node:child_process'

export type WslWorkspaceSurface = 'linux-native' | 'windows-drive' | 'unknown'

/** Classify the Windows spelling returned by `wslpath -w`. */
export function classifyWindowsSpelling(value: string): WslWorkspaceSurface {
  const trimmed = value.trim()
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return 'windows-drive'
  if (/^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(trimmed)) return 'linux-native'
  return 'unknown'
}

/** Whether a Windows-drive mount advertises DrvFS metadata semantics. */
export function mountHasMetadata(options: string): boolean {
  return options
    .split(/[;,\s]+/)
    .map(value => value.trim().toLowerCase())
    .includes('metadata')
}

export const WSL_PARITY_DOCTOR_SCRIPT = [
  'warn=0',
  'yesno() { if "$@"; then printf yes; else printf no; fi; }',
  'printf "tty: stdin=%s stdout=%s stderr=%s\\n" "$(yesno test -t 0)" "$(yesno test -t 1)" "$(yesno test -t 2)"',
  'charset=$(locale charmap 2>/dev/null || true)',
  '[ -n "$charset" ] || charset=unknown',
  'printf "locale-charmap: %s\\n" "$charset"',
  'case "$charset" in UTF-8|utf-8|UTF8|utf8) ;; *) printf "locale-parity: WARN (UTF-8 locale recommended for cross-Windows/Linux task text and tool output)\\n"; warn=1;; esac',
  'if command -v wslpath >/dev/null 2>&1; then',
  '  win_path=$(wslpath -w "$PWD" 2>/dev/null || true)',
  '  if [ -n "$win_path" ]; then',
  '    printf "workspace-windows-path: %s\\n" "$win_path"',
  '    case "$win_path" in [A-Za-z]:\\\\*|[A-Za-z]:/*) surface=windows-drive;; \\\\wsl.localhost\\*|\\\\wsl\$\\*) surface=linux-native;; *) surface=unknown;; esac',
  '    printf "workspace-surface: %s\\n" "$surface"',
  '    roundtrip=$(wslpath -u "$win_path" 2>/dev/null || true)',
  '    if [ -z "$roundtrip" ]; then printf "path-roundtrip: WARN (wslpath could not map the Windows spelling back to Linux)\\n"; warn=1; else printf "path-roundtrip: OK (%s)\\n" "$roundtrip"; fi',
  '  else',
  '    printf "workspace-windows-path: UNKNOWN\\n"',
  '    printf "workspace-surface: unknown\\n"',
  '    warn=1',
  '  fi',
  'else',
  '  printf "wslpath: MISSING\\n"',
  '  surface=unknown',
  '  warn=1',
  'fi',
  'if command -v findmnt >/dev/null 2>&1; then',
  '  fs_type=$(findmnt -T . -n -o FSTYPE 2>/dev/null || true)',
  '  fs_opts=$(findmnt -T . -n -o OPTIONS 2>/dev/null || true)',
  '  printf "workspace-mount: fstype=%s\\n" "${fs_type:-unknown}"',
  '  if [ "${surface:-unknown}" = windows-drive ]; then',
  '    case ",${fs_opts}," in *,metadata,*) printf "drvfs-metadata: enabled\\n";; *) printf "drvfs-metadata: WARN (not detected; chmod/chown and some POSIX permission semantics may differ from native Linux)\\n"; warn=1;; esac',
  '  fi',
  'else',
  '  printf "workspace-mount: UNKNOWN (findmnt missing)\\n"',
  'fi',
  'if command -v cmd.exe >/dev/null 2>&1 || command -v powershell.exe >/dev/null 2>&1; then printf "wsl-interop: available\\n"; else printf "wsl-interop: unavailable (not required for core DSH execution, but Windows-tool interop is disabled)\\n"; fi',
  'if [ "$warn" -ne 0 ]; then printf "parity-summary: WARN\\n"; else printf "parity-summary: OK\\n"; fi',
  'exit 0',
].join('\n')

function distroPrefix(distro?: string): string[] {
  return distro === undefined ? [] : ['--distribution', distro]
}

export function buildWslParityDoctorArgs(linuxCwd: string, distro?: string): string[] {
  return [
    ...distroPrefix(distro),
    '--cd', linuxCwd,
    '--exec', '/bin/sh', '-c', WSL_PARITY_DOCTOR_SCRIPT,
  ]
}

/**
 * Read-only parity diagnostics. Warnings do not fail `--wsl-doctor`: the core
 * doctor owns hard availability failures; this layer explains semantic drift.
 */
export function runWslParityDoctor(
  linuxCwd: string,
  env: NodeJS.ProcessEnv = process.env,
  distro?: string,
  run: typeof spawnSync = spawnSync,
): number {
  const result = run('wsl.exe', buildWslParityDoctorArgs(linuxCwd, distro), {
    env,
    stdio: 'inherit',
    windowsHide: false,
    timeout: 15_000,
  })
  if (result.error !== undefined || result.status === null) {
    console.error('[orcana-wsl] parity doctor could not complete; core WSL doctor remains authoritative')
    return 0
  }
  return 0
}
