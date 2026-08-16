import { spawn } from 'node:child_process'
import {
  DEFAULT_WSL_BUNDLES,
  DEFAULT_WSL_DSH_PACKAGE,
  DSH_VERSION_CONTRACT_SCRIPT,
  environmentForWsl,
  hostCwdForWslSpawn,
  windowsPathToWsl,
} from './wsl-bridge.js'
import {
  DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES,
  DEFAULT_WSL_PNPM_PACKAGE,
  DSH_HEADLESS_PACKAGE,
  DSH_WEB_APP_PACKAGE,
  buildWslCompanionInstallArgs,
  nativeCompanionInstallShellArgs,
} from './wsl-install.js'
import {
  buildWslCompanionProfileExpectation,
  buildWslProfileVerifyArgs,
  profileVerifyNodeArgs,
  type WslProfileExpectation,
} from './wsl-profile.js'

/** Product-owned companion profile name; the upstream `web` profile is never mutated. */
export function orcanaWebProfileName(baseProfile: string): string {
  return `${baseProfile}-web`
}

/**
 * Turn DSH's `web` alias into an explicit Orcana Web profile invocation.
 * Alias-owned flags keep their order, so `web --patch x --host ...` becomes
 * `--profile <base>-web --patch x --host ...` and DSH retains the same
 * launcher/app argument boundary.
 */
export function rewriteOrcanaWebInvocation(
  dshArgs: readonly string[],
  baseProfile: string,
): string[] {
  if (dshArgs[0] !== 'web') return [...dshArgs]
  return ['--profile', orcanaWebProfileName(baseProfile), ...dshArgs.slice(1)]
}

function exitCodeFromSignal(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return signal === null ? 1 : 128
}

async function runChild(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; windowsWsl: boolean },
): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      windowsHide: false,
    })
    let settled = false
    const onSigint = () => {
      // On Windows the console event already reaches wsl.exe. The listener
      // merely keeps this Node launcher alive long enough to return its code.
    }
    const onSigbreak = () => {
      // Same ownership rule as Ctrl+C.
    }
    const finish = (code: number) => {
      if (settled) return
      settled = true
      if (options.windowsWsl) {
        process.off('SIGINT', onSigint)
        process.off('SIGBREAK', onSigbreak)
      }
      resolve(code)
    }
    if (options.windowsWsl) {
      process.on('SIGINT', onSigint)
      process.on('SIGBREAK', onSigbreak)
    }
    child.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') console.error(`${command} was not found`)
      else console.error(error instanceof Error ? error.message : String(error))
      finish(127)
    })
    child.once('close', (code, signal) => finish(code ?? exitCodeFromSignal(signal)))
  })
}

function companionExpectation(dshPackage: string, companionName: string): WslProfileExpectation {
  return buildWslCompanionProfileExpectation(
    dshPackage,
    companionName,
    DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES,
    DEFAULT_WSL_BUNDLES,
  )
}

async function verifyCompanionProfile(
  profile: string,
  companionName: string,
  missingOk: boolean,
  env: NodeJS.ProcessEnv,
  cwd: string,
  distro?: string,
): Promise<number> {
  const dshPackage = env.ORCANA_WSL_DSH_PACKAGE?.trim() || DEFAULT_WSL_DSH_PACKAGE
  let expectation: WslProfileExpectation
  try {
    expectation = companionExpectation(dshPackage, companionName)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[orcana-wsl] exact profile check unavailable for ${profile}: ${message}`)
    return missingOk ? 0 : 78
  }

  let code: number
  if (process.platform !== 'win32') {
    code = await runChild(process.execPath, profileVerifyNodeArgs(profile, expectation), {
      env,
      cwd,
      windowsWsl: false,
    })
  } else {
    const hostCwd = hostCwdForWslSpawn(cwd, env)
    const childEnv = environmentForWsl(env)
    code = await runChild('wsl.exe', buildWslProfileVerifyArgs(profile, expectation, distro), {
      env: childEnv,
      cwd: hostCwd,
      windowsWsl: true,
    })
  }

  if (code === 2 && missingOk) return 0
  if (code === 2) {
    console.error(`[orcana-wsl] profile=${profile} is required for this dsh-orcana command; run dsh-orcana --wsl-install first`)
  }
  return code
}

export async function verifyOrcanaHeadlessProfile(
  baseProfile: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  distro?: string,
  missingOk = false,
): Promise<number> {
  return await verifyCompanionProfile(baseProfile, DSH_HEADLESS_PACKAGE, missingOk, env, cwd, distro)
}

export async function verifyOrcanaWebProfile(
  baseProfile: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  distro?: string,
  missingOk = true,
): Promise<number> {
  return await verifyCompanionProfile(
    orcanaWebProfileName(baseProfile),
    DSH_WEB_APP_PACKAGE,
    missingOk,
    env,
    cwd,
    distro,
  )
}

/**
 * Install and strictly verify the Orcana Web profile using the same pinned
 * DSH/pnpm/Orcana closure as headless, replacing only the DSH companion bundle
 * with `@deepseek-ai/dsh-web-app` at the exact CLI version.
 */
export async function installOrcanaWebProfile(
  baseProfile: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  distro?: string,
): Promise<number> {
  const dshPackage = env.ORCANA_WSL_DSH_PACKAGE?.trim() || DEFAULT_WSL_DSH_PACKAGE
  const pnpmPackage = env.ORCANA_WSL_PNPM_PACKAGE?.trim() || DEFAULT_WSL_PNPM_PACKAGE
  const webProfile = orcanaWebProfileName(baseProfile)
  const installDshArgs = ['plugin', '--profile', webProfile, 'add', ...DEFAULT_WSL_BUNDLES]
  const expectation = companionExpectation(dshPackage, DSH_WEB_APP_PACKAGE)

  if (process.platform !== 'win32') {
    const installCode = await runChild('/bin/sh', nativeCompanionInstallShellArgs(
      installDshArgs,
      dshPackage,
      DSH_WEB_APP_PACKAGE,
      DSH_VERSION_CONTRACT_SCRIPT,
      pnpmPackage,
    ), { env, cwd, windowsWsl: false })
    if (installCode !== 0) return installCode
    return await runChild(process.execPath, profileVerifyNodeArgs(webProfile, expectation), {
      env,
      cwd,
      windowsWsl: false,
    })
  }

  const mapped = windowsPathToWsl(cwd, distro)
  const selectedDistro = distro ?? mapped.distro
  const hostCwd = hostCwdForWslSpawn(cwd, env)
  const childEnv = environmentForWsl(env)
  const installCode = await runChild('wsl.exe', buildWslCompanionInstallArgs(
    mapped.linuxPath,
    installDshArgs,
    dshPackage,
    DSH_WEB_APP_PACKAGE,
    DSH_VERSION_CONTRACT_SCRIPT,
    selectedDistro,
    pnpmPackage,
  ), {
    env: childEnv,
    cwd: hostCwd,
    windowsWsl: true,
  })
  if (installCode !== 0) return installCode
  return await runChild('wsl.exe', buildWslProfileVerifyArgs(webProfile, expectation, selectedDistro), {
    env: childEnv,
    cwd: hostCwd,
    windowsWsl: true,
  })
}
