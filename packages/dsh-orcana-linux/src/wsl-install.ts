export const DEFAULT_WSL_PNPM_PACKAGE = 'pnpm@11.7.0'

/**
 * Run DSH plugin management with an exact local toolchain when available;
 * otherwise ask npx for both pinned packages in one ephemeral execution env.
 * User/plugin arguments remain positional parameters only.
 */
export const INSTALL_RESOLVER_SCRIPT = [
  'dsh_package=$1',
  'pnpm_package=$2',
  'version_contract=$3',
  'shift 3',
  'if command -v dsh >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then',
  '  dsh_version=$(dsh --version 2>/dev/null || true)',
  '  pnpm_version=$(pnpm --version 2>/dev/null || true)',
  '  if node -e "$version_contract" "$dsh_package" "$dsh_version" >/dev/null 2>&1 && node -e "$version_contract" "$pnpm_package" "$pnpm_version" >/dev/null 2>&1; then exec dsh "$@"; fi',
  '  printf "%s\\n" "dsh-orcana: installed dsh/pnpm toolchain does not match pinned install toolchain; using npx bootstrap" >&2',
  'fi',
  'if command -v npx >/dev/null 2>&1; then exec npx --yes --package="$pnpm_package" --package="$dsh_package" -- dsh "$@"; fi',
  'printf "%s\\n" "dsh-orcana: plugin installation needs either the pinned dsh+pnpm toolchain or npx" >&2',
  'exit 127',
].join('\n')

function distroPrefix(distro?: string): string[] {
  return distro === undefined ? [] : ['--distribution', distro]
}

export function nativeInstallShellArgs(
  dshArgs: readonly string[],
  dshPackage: string,
  versionContract: string,
  pnpmPackage = DEFAULT_WSL_PNPM_PACKAGE,
): string[] {
  return [
    '-lc', INSTALL_RESOLVER_SCRIPT, 'dsh-orcana-install',
    dshPackage, pnpmPackage, versionContract, ...dshArgs,
  ]
}

export function buildWslInstallArgs(
  linuxCwd: string,
  dshArgs: readonly string[],
  dshPackage: string,
  versionContract: string,
  distro?: string,
  pnpmPackage = DEFAULT_WSL_PNPM_PACKAGE,
): string[] {
  return [
    ...distroPrefix(distro),
    '--cd', linuxCwd,
    '--exec', '/bin/sh',
    ...nativeInstallShellArgs(dshArgs, dshPackage, versionContract, pnpmPackage),
  ]
}
