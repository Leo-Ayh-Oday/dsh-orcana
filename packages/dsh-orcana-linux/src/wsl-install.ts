export const DEFAULT_WSL_PNPM_PACKAGE = 'pnpm@11.7.0'

export const DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES = Object.freeze([
  '@leooday/governor-core@0.1.0-rc.1',
  '@leooday/dsh-governor@0.1.0-rc.1',
  '@leooday/dsh-orcana-linux@0.4.0',
] as const)

const DSH_PACKAGE_PREFIX = '@deepseek-ai/dsh@'
const DSH_HEADLESS_PACKAGE = '@deepseek-ai/dsh-headless'

/**
 * Derive an official DSH companion package at the same selector/version as the
 * selected CLI. This keeps the one-shot task surface in lockstep with the DSH
 * runtime instead of hard-coding a second independently drifting version.
 */
export function dshCompanionPackage(dshPackage: string, companionName: string): string {
  if (dshPackage === '@deepseek-ai/dsh') return companionName
  if (!dshPackage.startsWith(DSH_PACKAGE_PREFIX)) {
    throw new Error(`cannot derive ${companionName} from DSH package spec ${JSON.stringify(dshPackage)}`)
  }
  const selector = dshPackage.slice(DSH_PACKAGE_PREFIX.length)
  if (selector.length === 0) {
    throw new Error(`cannot derive ${companionName} from an empty DSH package selector`)
  }
  return `${companionName}@${selector}`
}

export function dshHeadlessPackage(dshPackage: string): string {
  return dshCompanionPackage(dshPackage, DSH_HEADLESS_PACKAGE)
}

/**
 * Dedicated `--wsl-install` resolver.
 *
 * It creates a runnable and reproducible profile using an exact DSH/pnpm
 * toolchain, exact DSH headless bundle, exact Orcana runtime closure, and exact
 * Orcana bundles. After `dsh plugin add` succeeds, it runs the official
 * boot-free `dsh --profile <name> --dump-config` path. The install is reported
 * successful only when the resulting profile patch stack can actually compose.
 */
export const INSTALL_RESOLVER_SCRIPT = [
  'dsh_package=$1',
  'pnpm_package=$2',
  'version_contract=$3',
  'headless_package=$4',
  'orcana_packages=$5',
  'shift 5',
  'if [ "$1" != "plugin" ] || [ "$2" != "--profile" ] || [ -z "$3" ] || [ "$4" != "add" ]; then',
  '  printf "%s\\n" "dsh-orcana: internal install argv does not match plugin --profile <name> add" >&2',
  '  exit 64',
  'fi',
  'profile=$3',
  'shift 4',
  '# The Orcana release package list is compile-time controlled and contains no spaces/globs.',
  'set -f',
  'set -- plugin --profile "$profile" add --save-exact "$headless_package" $orcana_packages "$@"',
  'runner=npx',
  'if command -v dsh >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then',
  '  dsh_version=$(dsh --version 2>/dev/null || true)',
  '  pnpm_version=$(pnpm --version 2>/dev/null || true)',
  '  if node -e "$version_contract" "$dsh_package" "$dsh_version" >/dev/null 2>&1 && node -e "$version_contract" "$pnpm_package" "$pnpm_version" >/dev/null 2>&1; then runner=local; fi',
  'fi',
  'if [ "$runner" = local ]; then',
  '  dsh "$@"',
  '  install_status=$?',
  'else',
  '  if ! command -v npx >/dev/null 2>&1; then printf "%s\\n" "dsh-orcana: plugin installation needs either the pinned dsh+pnpm toolchain or npx" >&2; exit 127; fi',
  '  npx --yes --package="$pnpm_package" --package="$dsh_package" -- dsh "$@"',
  '  install_status=$?',
  'fi',
  'if [ "$install_status" -ne 0 ]; then exit "$install_status"; fi',
  '# rc.5 --dump-config composes bundle/profile/overlay patches without booting the runtime or evaluating !!js.',
  'if [ "$runner" = local ]; then',
  '  dsh --profile "$profile" --dump-config >/dev/null',
  '  smoke_status=$?',
  'else',
  '  npx --yes --package="$dsh_package" -- dsh --profile "$profile" --dump-config >/dev/null',
  '  smoke_status=$?',
  'fi',
  'if [ "$smoke_status" -ne 0 ]; then',
  '  printf "%s\\n" "dsh-orcana: profile install completed but composition smoke failed for profile '$profile'" >&2',
  '  exit "$smoke_status"',
  'fi',
  'printf "%s\\n" "dsh-orcana: profile '$profile' installed and composition smoke passed" >&2',
  'exit 0',
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
  const headlessPackage = dshHeadlessPackage(dshPackage)
  const orcanaPackages = DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES.join(' ')
  return [
    '-c', INSTALL_RESOLVER_SCRIPT, 'dsh-orcana-install',
    dshPackage, pnpmPackage, versionContract, headlessPackage, orcanaPackages, ...dshArgs,
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
