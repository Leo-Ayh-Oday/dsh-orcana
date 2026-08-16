export const DEFAULT_WSL_PNPM_PACKAGE = 'pnpm@11.7.0'
export const INSTALL_NODE_CONTRACT_SCRIPT = 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 19) || major >= 24 ? 0 : 1)'

export const DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES = Object.freeze([
  '@leooday/governor-core@0.1.0-rc.1',
  '@leooday/dsh-governor@0.1.0-rc.1',
  '@leooday/dsh-orcana-linux@0.4.0',
] as const)

export interface ExactPackageSpec {
  name: string
  version: string
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function parseExactPackageSpec(spec: string): ExactPackageSpec {
  const at = spec.lastIndexOf('@')
  if (at <= 0) throw new Error(`package spec must include an exact version: ${JSON.stringify(spec)}`)
  const name = spec.slice(0, at)
  const version = spec.slice(at + 1)
  if (!EXACT_SEMVER.test(version)) {
    throw new Error(`package spec must use an exact semver version: ${JSON.stringify(spec)}`)
  }
  return { name, version }
}

const DSH_PACKAGE = '@deepseek-ai/dsh'
export const DSH_HEADLESS_PACKAGE = '@deepseek-ai/dsh-headless'
export const DSH_WEB_APP_PACKAGE = '@deepseek-ai/dsh-web-app'

/**
 * Derive an official DSH companion package at the exact version selected for
 * the CLI. Install-time selectors are deliberately exact; floating tags/ranges
 * remain allowed only for ordinary runtime compatibility experiments.
 */
export function dshCompanionPackage(dshPackage: string, companionName: string): string {
  const parsed = parseExactPackageSpec(dshPackage)
  if (parsed.name !== DSH_PACKAGE) {
    throw new Error(`expected ${DSH_PACKAGE}@<exact-version>, received ${JSON.stringify(dshPackage)}`)
  }
  return `${companionName}@${parsed.version}`
}

export function dshHeadlessPackage(dshPackage: string): string {
  return dshCompanionPackage(dshPackage, DSH_HEADLESS_PACKAGE)
}

export function dshWebAppPackage(dshPackage: string): string {
  return dshCompanionPackage(dshPackage, DSH_WEB_APP_PACKAGE)
}

/**
 * Exact profile-install resolver shared by headless and Web Orcana profiles.
 *
 * Bundle-bearing packages are intentionally installed in separate DSH plugin
 * transactions. DSH appends newly discovered bundle layers when it reconciles
 * each transaction, so the final layer order does not depend on how pnpm
 * chooses to order package.json dependency keys.
 */
export const INSTALL_RESOLVER_SCRIPT = [
  'dsh_package=$1',
  'pnpm_package=$2',
  'version_contract=$3',
  'node_contract=$4',
  'companion_package=$5',
  'orcana_packages=$6',
  'shift 6',
  'if ! command -v node >/dev/null 2>&1; then printf "%s\\n" "dsh-orcana: Node.js is required inside the Linux execution world" >&2; exit 126; fi',
  'if ! node -e "$node_contract" >/dev/null 2>&1; then node_version=$(node --version 2>/dev/null || true); printf "%s\\n" "dsh-orcana: unsupported Node ${node_version:-unknown}; need ^22.19.0 || >=24.0.0" >&2; exit 126; fi',
  'if [ "$1" != "plugin" ] || [ "$2" != "--profile" ] || [ -z "$3" ] || [ "$4" != "add" ]; then',
  '  printf "%s\\n" "dsh-orcana: internal install argv does not match plugin --profile <name> add" >&2',
  '  exit 64',
  'fi',
  'profile=$3',
  'shift 4',
  '# Remaining positional parameters are the exact Orcana bundle specs, in required layer order.',
  'runner=npx',
  'if command -v dsh >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then',
  '  dsh_version=$(dsh --version 2>/dev/null || true)',
  '  pnpm_version=$(pnpm --version 2>/dev/null || true)',
  '  if node -e "$version_contract" "$dsh_package" "$dsh_version" >/dev/null 2>&1 && node -e "$version_contract" "$pnpm_package" "$pnpm_version" >/dev/null 2>&1; then runner=local; fi',
  'fi',
  'if [ "$runner" != local ] && ! command -v npx >/dev/null 2>&1; then printf "%s\\n" "dsh-orcana: plugin installation needs either the pinned dsh+pnpm toolchain or npx" >&2; exit 127; fi',
  'run_plugin() {',
  '  if [ "$runner" = local ]; then dsh "$@"; return $?; fi',
  '  npx --yes --package="$pnpm_package" --package="$dsh_package" -- dsh "$@"',
  '}',
  '# Phase 1: install the DSH companion alone so it is the first dependency-managed bundle layer.',
  'run_plugin plugin --profile "$profile" add --save-exact "$companion_package"',
  'install_status=$?',
  'if [ "$install_status" -ne 0 ]; then exit "$install_status"; fi',
  '# Phase 2: pin Orcana implementation packages. They are plain dependencies, not dsh.bundle layers.',
  'set -f',
  'if [ -n "$orcana_packages" ]; then',
  '  run_plugin plugin --profile "$profile" add --save-exact $orcana_packages',
  '  install_status=$?',
  '  if [ "$install_status" -ne 0 ]; then exit "$install_status"; fi',
  'fi',
  '# Phase 3+: install each Orcana bundle separately, preserving the declared layer order independent of pnpm key sorting.',
  'for bundle_spec in "$@"; do',
  '  run_plugin plugin --profile "$profile" add --save-exact "$bundle_spec"',
  '  install_status=$?',
  '  if [ "$install_status" -ne 0 ]; then exit "$install_status"; fi',
  'done',
  '# rc.5 --dump-config composes bundle/profile/overlay patches without booting the runtime or evaluating !!js.',
  'if [ "$runner" = local ]; then',
  '  dsh --profile "$profile" --dump-config >/dev/null',
  '  smoke_status=$?',
  'else',
  '  npx --yes --package="$dsh_package" -- dsh --profile "$profile" --dump-config >/dev/null',
  '  smoke_status=$?',
  'fi',
  'if [ "$smoke_status" -ne 0 ]; then',
  '  printf "%s\\n" "dsh-orcana: profile install completed but composition smoke failed for profile=$profile" >&2',
  '  exit "$smoke_status"',
  'fi',
  'printf "%s\\n" "dsh-orcana: profile=$profile installed and composition smoke passed" >&2',
  'exit 0',
].join('\n')

function distroPrefix(distro?: string): string[] {
  return distro === undefined ? [] : ['--distribution', distro]
}

export function nativeCompanionInstallShellArgs(
  dshArgs: readonly string[],
  dshPackage: string,
  companionName: string,
  versionContract: string,
  pnpmPackage = DEFAULT_WSL_PNPM_PACKAGE,
  nodeContract = INSTALL_NODE_CONTRACT_SCRIPT,
): string[] {
  const parsedPnpm = parseExactPackageSpec(pnpmPackage)
  if (parsedPnpm.name !== 'pnpm') {
    throw new Error(`expected pnpm@<exact-version>, received ${JSON.stringify(pnpmPackage)}`)
  }
  const companionPackage = dshCompanionPackage(dshPackage, companionName)
  for (const spec of DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES) parseExactPackageSpec(spec)
  const orcanaPackages = DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES.join(' ')
  return [
    '-c', INSTALL_RESOLVER_SCRIPT, 'dsh-orcana-install',
    dshPackage, pnpmPackage, versionContract, nodeContract, companionPackage, orcanaPackages, ...dshArgs,
  ]
}

/** Back-compatible headless install helper. */
export function nativeInstallShellArgs(
  dshArgs: readonly string[],
  dshPackage: string,
  versionContract: string,
  pnpmPackage = DEFAULT_WSL_PNPM_PACKAGE,
  nodeContract = INSTALL_NODE_CONTRACT_SCRIPT,
): string[] {
  return nativeCompanionInstallShellArgs(
    dshArgs,
    dshPackage,
    DSH_HEADLESS_PACKAGE,
    versionContract,
    pnpmPackage,
    nodeContract,
  )
}

export function buildWslCompanionInstallArgs(
  linuxCwd: string,
  dshArgs: readonly string[],
  dshPackage: string,
  companionName: string,
  versionContract: string,
  distro?: string,
  pnpmPackage = DEFAULT_WSL_PNPM_PACKAGE,
  nodeContract = INSTALL_NODE_CONTRACT_SCRIPT,
): string[] {
  return [
    ...distroPrefix(distro),
    '--cd', linuxCwd,
    '--exec', '/bin/sh',
    ...nativeCompanionInstallShellArgs(
      dshArgs,
      dshPackage,
      companionName,
      versionContract,
      pnpmPackage,
      nodeContract,
    ),
  ]
}

/** Back-compatible headless WSL install helper. */
export function buildWslInstallArgs(
  linuxCwd: string,
  dshArgs: readonly string[],
  dshPackage: string,
  versionContract: string,
  distro?: string,
  pnpmPackage = DEFAULT_WSL_PNPM_PACKAGE,
  nodeContract = INSTALL_NODE_CONTRACT_SCRIPT,
): string[] {
  return buildWslCompanionInstallArgs(
    linuxCwd,
    dshArgs,
    dshPackage,
    DSH_HEADLESS_PACKAGE,
    versionContract,
    distro,
    pnpmPackage,
    nodeContract,
  )
}
