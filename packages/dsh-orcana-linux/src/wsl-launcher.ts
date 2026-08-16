import { spawnSync } from 'node:child_process'
import { augmentWslHostEnvironment } from './wsl-host-env.js'
import { reportWslLoopbackProxyDoctor } from './wsl-proxy-doctor.js'
import {
  installOrcanaWebProfile,
  rewriteOrcanaWebInvocation,
  verifyOrcanaWebProfile,
} from './wsl-product-profiles.js'
import { reportWslWebDoctor } from './wsl-web-doctor.js'
import { runWslWorkspaceDoctor } from './wsl-workspace-doctor.js'
import {
  launchWslBridge,
  parseWslBridgeArgs,
  parseWslUncPath,
  windowsPathToWsl,
  type WslBridgeOptions,
} from './wsl-bridge.js'

interface TranslatedPluginArgs {
  args: string[]
  distro?: string
}

function localPackageSpec(argument: string): { prefix: string; path: string } | undefined {
  const prefixed = /^(?<prefix>(?:file|link):)(?<path>.*)$/.exec(argument)
  const prefix = prefixed?.groups?.prefix ?? ''
  const path = prefixed?.groups?.path ?? argument
  const relative = /^\.{1,2}(?:[/\\].*)?$/.test(path)
  const driveAbsolute = /^[A-Za-z]:[/\\]/.test(path)
  const uncAbsolute = /^\\\\/.test(path)
  if (!relative && !driveAbsolute && !uncAbsolute) return undefined
  return { prefix, path }
}

function pluginPnpmArgsStart(args: readonly string[]): number | undefined {
  // DSH itself rejects parent --profile/--patch/--dump-* before `plugin`, so
  // only the exact subcommand shape is eligible for launcher rewriting.
  if (args[0] !== 'plugin') return undefined
  const profileArg = args[1]
  if (profileArg === '--profile') {
    return args[2] === undefined ? undefined : 3
  }
  if (profileArg?.startsWith('--profile=')) return 2
  return undefined
}

/**
 * Choose the WSL distro before any absolute-path translation. A WSL UNC cwd
 * owns its distro; an explicit selector may agree with it but may not silently
 * redirect that workspace into another Linux world.
 */
export function distroForWindowsWorkspace(cwd: string, configured?: string): string | undefined {
  const unc = parseWslUncPath(cwd)
  if (unc === undefined) return configured
  if (configured !== undefined && configured.toLowerCase() !== unc.distro.toLowerCase()) {
    throw new Error(`cwd belongs to WSL distro '${unc.distro}' but --wsl-distro selected '${configured}'`)
  }
  return configured ?? unc.distro
}

/**
 * Translate only filesystem package specs owned by `dsh plugin`/pnpm.
 * Registry, git and arbitrary pnpm arguments remain byte-for-byte unchanged.
 * Relative specs need only slash normalization because DSH itself anchors them
 * against the already-mapped Linux cwd. Absolute Windows/UNC specs are handed
 * to the selected distro's `wslpath`.
 */
export function translateDshPluginPathSpecsForWsl(
  args: readonly string[],
  distro?: string,
  run: typeof spawnSync = spawnSync,
): TranslatedPluginArgs {
  const start = pluginPnpmArgsStart(args)
  if (start === undefined) return { args: [...args], ...(distro === undefined ? {} : { distro }) }

  const translated = [...args]
  let selectedDistro = distro
  for (let i = start; i < translated.length; i += 1) {
    const spec = localPackageSpec(translated[i]!)
    if (spec === undefined) continue

    if (/^\.{1,2}(?:[/\\].*)?$/.test(spec.path)) {
      translated[i] = `${spec.prefix}${spec.path.replaceAll('\\', '/')}`
      continue
    }

    const mapped = windowsPathToWsl(spec.path, selectedDistro, run)
    selectedDistro ??= mapped.distro
    translated[i] = `${spec.prefix}${mapped.linuxPath}`
  }

  return {
    args: translated,
    ...(selectedDistro === undefined ? {} : { distro: selectedDistro }),
  }
}

function canonicalBridgeArgs(options: WslBridgeOptions, dshArgs: readonly string[]): string[] {
  const args: string[] = []
  if (options.distro !== undefined) args.push('--wsl-distro', options.distro)
  args.push('--wsl-profile', options.profile)
  if (options.mode === 'install') args.push('--wsl-install')
  else if (options.mode === 'doctor') args.push('--wsl-doctor')
  args.push(...dshArgs)
  return args
}

/**
 * Preferred cross-platform launcher API.
 *
 * Product semantics live here rather than in the transport primitive:
 * - task invocations use `<profile>` (default `orcana`)
 * - `web ...` uses `<profile>-web` and therefore never silently falls back to
 *   the upstream plain-Web profile
 * - `--wsl-install` prepares and verifies both companion profiles
 *
 * Windows additionally normalizes DSH bootstrap proxy/search/certificate
 * environment, local `dsh plugin` filesystem specs, and WSL distro ownership.
 * Doctor proves the same localhost transport DSH Web uses rather than widening
 * the server bind address when forwarding is misconfigured.
 */
export async function launchDshOrcana(
  rawArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<number> {
  const isWindows = process.platform === 'win32'
  const effectiveEnv = isWindows ? augmentWslHostEnvironment(env) : env
  const parsed = parseWslBridgeArgs(rawArgs, effectiveEnv)
  const selectedDistro = isWindows ? distroForWindowsWorkspace(cwd, parsed.distro) : parsed.distro
  const baseOptions: WslBridgeOptions = {
    ...parsed,
    ...(selectedDistro === undefined ? {} : { distro: selectedDistro }),
  }

  if (parsed.mode === 'doctor') {
    const bridgeStatus = await launchWslBridge(canonicalBridgeArgs(baseOptions, parsed.dshArgs), effectiveEnv, cwd)
    if (bridgeStatus !== 0) return bridgeStatus

    const webStatus = await verifyOrcanaWebProfile(parsed.profile, effectiveEnv, cwd, selectedDistro)
    if (webStatus !== 0) return webStatus

    if (!isWindows) return 0
    const webRelayStatus = await reportWslWebDoctor(effectiveEnv, selectedDistro, cwd)
    if (webRelayStatus !== 0) return webRelayStatus
    const proxyStatus = reportWslLoopbackProxyDoctor(effectiveEnv, selectedDistro)
    const mapped = windowsPathToWsl(cwd, selectedDistro)
    const workspaceStatus = runWslWorkspaceDoctor(mapped.linuxPath, effectiveEnv, selectedDistro)
    return proxyStatus !== 0 ? proxyStatus : workspaceStatus
  }

  if (parsed.mode === 'install') {
    const headlessStatus = await launchWslBridge(canonicalBridgeArgs(baseOptions, parsed.dshArgs), effectiveEnv, cwd)
    if (headlessStatus !== 0) return headlessStatus
    return await installOrcanaWebProfile(parsed.profile, effectiveEnv, cwd, selectedDistro)
  }

  const productArgs = rewriteOrcanaWebInvocation(parsed.dshArgs, parsed.profile)
  if (!isWindows) {
    return await launchWslBridge(canonicalBridgeArgs(baseOptions, productArgs), effectiveEnv, cwd)
  }

  const plugin = translateDshPluginPathSpecsForWsl(productArgs, selectedDistro)
  const effectiveOptions: WslBridgeOptions = {
    ...baseOptions,
    ...(plugin.distro === undefined ? {} : { distro: plugin.distro }),
    dshArgs: plugin.args,
  }
  return await launchWslBridge(canonicalBridgeArgs(effectiveOptions, plugin.args), effectiveEnv, cwd)
}
