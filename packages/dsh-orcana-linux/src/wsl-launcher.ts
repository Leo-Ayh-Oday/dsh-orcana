import { augmentWslHostEnvironment } from './wsl-host-env.js'
import { launchWslBridge } from './wsl-bridge.js'

/**
 * Preferred cross-platform launcher API.
 *
 * On Windows, first augments the host environment with DSH bootstrap-only
 * proxy/search/certificate settings, then hands the run to the core WSL
 * bridge. Native Linux/WSL runs pass their environment through unchanged.
 */
export async function launchDshOrcana(
  rawArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const effectiveEnv = platform === 'win32' ? augmentWslHostEnvironment(env) : env
  return await launchWslBridge(rawArgs, effectiveEnv, cwd)
}
