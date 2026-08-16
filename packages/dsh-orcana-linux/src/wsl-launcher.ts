import { spawnSync } from 'node:child_process'
import { augmentWslHostEnvironment } from './wsl-host-env.js'
import {
  launchWslBridge,
  parseWslBridgeArgs,
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

function pluginCommandIndex(args: readonly string[]): number | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') return undefined
    if (arg === '--profile' || arg === '--patch') {
      i += 1
      continue
    }
    if (arg.startsWith('--profile=') || arg.startsWith('--patch=')) continue
    if (arg === '--dump-config' || arg === '--dump-default-config') continue
    return arg === 'plugin' ? i : undefined
  }
  return undefined
}

function pluginPnpmArgsStart(args: readonly string[], pluginIndex: number): number | undefined {
  let i = pluginIndex + 1
  const profileArg = args[i]
  if (profileArg === '--profile') {
    if (args[i + 1] === undefined) return undefined
    i += 2
  } else if (profileArg?.startsWith('--profile=')) {
    i += 1
  } else {
    return undefined
  }
  return i
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
  const pluginIndex = pluginCommandIndex(args)
  if (pluginIndex === undefined) return { args: [...args], ...(distro === undefined ? {} : { distro }) }
  const start = pluginPnpmArgsStart(args, pluginIndex)
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
 * Windows composition does two host-only normalizations before entering the
 * core bridge: DSH bootstrap proxy/search/certificate environment and local
 * filesystem package specs passed to `dsh plugin`. Native Linux/WSL runs keep
 * argv/environment unchanged.
 */
export async function launchDshOrcana(
  rawArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  if (platform !== 'win32') return await launchWslBridge(rawArgs, env, cwd)

  const effectiveEnv = augmentWslHostEnvironment(env)
  const parsed = parseWslBridgeArgs(rawArgs, effectiveEnv)
  if (parsed.mode !== 'run') {
    return await launchWslBridge(canonicalBridgeArgs(parsed, parsed.dshArgs), effectiveEnv, cwd)
  }

  const plugin = translateDshPluginPathSpecsForWsl(parsed.dshArgs, parsed.distro)
  const effectiveOptions: WslBridgeOptions = {
    ...parsed,
    ...(plugin.distro === undefined ? {} : { distro: plugin.distro }),
    dshArgs: plugin.args,
  }
  return await launchWslBridge(canonicalBridgeArgs(effectiveOptions, plugin.args), effectiveEnv, cwd)
}
