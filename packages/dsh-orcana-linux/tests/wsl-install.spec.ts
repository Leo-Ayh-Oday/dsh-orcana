import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES,
  DEFAULT_WSL_PNPM_PACKAGE,
  DSH_WEB_APP_PACKAGE,
  INSTALL_NODE_CONTRACT_SCRIPT,
  INSTALL_RESOLVER_SCRIPT,
  buildWslCompanionInstallArgs,
  buildWslInstallArgs,
  dshCompanionPackage,
  dshHeadlessPackage,
  dshWebAppPackage,
  nativeCompanionInstallShellArgs,
  nativeInstallShellArgs,
} from '../src/wsl-install.ts'

const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.6'
const HEADLESS_PACKAGE = '@deepseek-ai/dsh-headless@0.1.0-rc.6'
const WEB_PACKAGE = '@deepseek-ai/dsh-web-app@0.1.0-rc.6'
const VERSION_CONTRACT = 'const [spec,actual]=process.argv.slice(1);process.exit(spec.endsWith("@"+actual)?0:1)'
const ORCANA_RUNTIME_PACKAGES = [
  '@leooday/governor-core@0.1.0',
  '@leooday/dsh-governor@0.1.0',
  '@leooday/dsh-orcana-linux@0.4.0',
] as const

function withFakeLocalToolchain<T>(run: (env: NodeJS.ProcessEnv, log: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'dsh-orcana-install-'))
  const log = join(root, 'dsh.log')
  const dsh = join(root, 'dsh')
  const pnpm = join(root, 'pnpm')
  writeFileSync(dsh, [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$DSH_FAKE_LOG"',
    'if [ "$1" = "--version" ]; then printf "%s\\n" "0.1.0-rc.6"; exit 0; fi',
    'if [ "$1" = "plugin" ]; then exit "${DSH_FAKE_INSTALL_STATUS:-0}"; fi',
    'if [ "$1" = "--profile" ] && [ "$3" = "--dump-config" ]; then exit "${DSH_FAKE_SMOKE_STATUS:-0}"; fi',
    'exit 98',
  ].join('\n'))
  writeFileSync(pnpm, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then printf "%s\\n" "11.7.0"; exit 0; fi',
    'exit 99',
  ].join('\n'))
  chmodSync(dsh, 0o755)
  chmodSync(pnpm, 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ''}`,
    DSH_FAKE_LOG: log,
  }
  try {
    return run(env, log)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const INSTALL_ARGS = [
  'plugin', '--profile', 'orcana', 'add',
  '@leooday/dsh-bundle@0.1.0-rc.1',
  '@leooday/dsh-orcana-linux-bundle@0.3.0',
] as const

describe('WSL plugin-install toolchain', () => {
  it('pins the pnpm version, Node contract and Orcana implementation closure', () => {
    expect(DEFAULT_WSL_PNPM_PACKAGE).toBe('pnpm@11.7.0')
    expect(INSTALL_NODE_CONTRACT_SCRIPT).toContain('major === 22 && minor >= 19')
    expect(INSTALL_NODE_CONTRACT_SCRIPT).toContain('major >= 24')
    expect(DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES).toEqual(ORCANA_RUNTIME_PACKAGES)
  })

  it('derives headless and Web companion bundles only from an exact selected CLI package', () => {
    expect(dshHeadlessPackage(DSH_PACKAGE)).toBe(HEADLESS_PACKAGE)
    expect(dshWebAppPackage(DSH_PACKAGE)).toBe(WEB_PACKAGE)
    expect(dshHeadlessPackage('@deepseek-ai/dsh@0.1.0-rc.6')).toBe('@deepseek-ai/dsh-headless@0.1.0-rc.6')
    expect(() => dshCompanionPackage('@deepseek-ai/dsh', '@deepseek-ai/dsh-headless')).toThrow(/exact version/)
    expect(() => dshHeadlessPackage('file:../dsh')).toThrow(/exact version/)
  })

  it('checks Node before using exact local dsh+pnpm or an exact npx bootstrap', () => {
    expect(INSTALL_RESOLVER_SCRIPT).toContain('node -e "$node_contract"')
    expect(INSTALL_RESOLVER_SCRIPT).toContain('dsh --version')
    expect(INSTALL_RESOLVER_SCRIPT).toContain('pnpm --version')
    expect(INSTALL_RESOLVER_SCRIPT).toContain('node -e "$version_contract" "$dsh_package" "$dsh_version"')
    expect(INSTALL_RESOLVER_SCRIPT).toContain('node -e "$version_contract" "$pnpm_package" "$pnpm_version"')
    expect(INSTALL_RESOLVER_SCRIPT).toContain('npx --yes --package="$pnpm_package" --package="$dsh_package" -- dsh "$@"')
  })

  it('installs bundle-bearing packages in separate DSH transactions to pin layer order', () => {
    expect(INSTALL_RESOLVER_SCRIPT).toContain(
      'run_plugin plugin --profile "$profile" add --save-exact "$companion_package"',
    )
    expect(INSTALL_RESOLVER_SCRIPT).toContain(
      'run_plugin plugin --profile "$profile" add --save-exact $orcana_packages',
    )
    expect(INSTALL_RESOLVER_SCRIPT).toContain('for bundle_spec in "$@"; do')
    expect(INSTALL_RESOLVER_SCRIPT).toContain(
      'run_plugin plugin --profile "$profile" add --save-exact "$bundle_spec"',
    )
    expect(INSTALL_RESOLVER_SCRIPT).toContain('dsh --profile "$profile" --dump-config >/dev/null')
  })

  it('keeps plugin arguments positional and out of the fixed resolver script', () => {
    const packageName = '@leooday/dsh-orcana-linux-bundle; echo should-not-run'
    const args = nativeInstallShellArgs(
      ['plugin', '--profile', 'orcana', 'add', packageName],
      DSH_PACKAGE,
      VERSION_CONTRACT,
    )

    expect(args.slice(0, 10)).toEqual([
      '-c', INSTALL_RESOLVER_SCRIPT, 'dsh-orcana-install',
      DSH_PACKAGE, DEFAULT_WSL_PNPM_PACKAGE, VERSION_CONTRACT,
      INSTALL_NODE_CONTRACT_SCRIPT, HEADLESS_PACKAGE, ORCANA_RUNTIME_PACKAGES.join(' '), 'plugin',
    ])
    expect(INSTALL_RESOLVER_SCRIPT).not.toContain(packageName)
    expect(args.at(-1)).toBe(packageName)
  })

  it('uses the same exact installer for the Web companion', () => {
    const args = nativeCompanionInstallShellArgs(
      ['plugin', '--profile', 'orcana-web', 'add', '@leooday/dsh-bundle@0.1.0-rc.1'],
      DSH_PACKAGE,
      DSH_WEB_APP_PACKAGE,
      VERSION_CONTRACT,
    )
    expect(args[7]).toBe(WEB_PACKAGE)
    expect(args).toContain('orcana-web')
  })

  it.skipIf(process.platform === 'win32')('rejects accidental use with a non-plugin-add internal argv shape', () => {
    const result = spawnSync('/bin/sh', [
      '-c', INSTALL_RESOLVER_SCRIPT, 'dsh-orcana-install',
      DSH_PACKAGE, DEFAULT_WSL_PNPM_PACKAGE, VERSION_CONTRACT, INSTALL_NODE_CONTRACT_SCRIPT,
      HEADLESS_PACKAGE, ORCANA_RUNTIME_PACKAGES.join(' '),
      'web',
    ], { encoding: 'utf8' })

    expect(result.status).toBe(64)
    expect(result.stderr).toContain('internal install argv does not match')
  })

  it.skipIf(process.platform === 'win32')('fails before DSH/pnpm work when the Linux Node contract is unsupported', () => {
    withFakeLocalToolchain((env, log) => {
      const result = spawnSync('/bin/sh', nativeInstallShellArgs(
        INSTALL_ARGS,
        DSH_PACKAGE,
        VERSION_CONTRACT,
        DEFAULT_WSL_PNPM_PACKAGE,
        'process.exit(1)',
      ), { env, encoding: 'utf8' })
      expect(result.status).toBe(126)
      expect(result.stderr).toContain('unsupported Node')
      expect(() => readFileSync(log, 'utf8')).toThrow()
    })
  })

  it.skipIf(process.platform === 'win32')('runs deterministic headless phases before the composition smoke', () => {
    withFakeLocalToolchain((env, log) => {
      const result = spawnSync('/bin/sh', nativeInstallShellArgs(INSTALL_ARGS, DSH_PACKAGE, VERSION_CONTRACT), {
        env,
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('composition smoke passed')
      const calls = readFileSync(log, 'utf8').trim().split('\n')
      expect(calls.slice(-5)).toEqual([
        `plugin --profile orcana add --save-exact ${HEADLESS_PACKAGE}`,
        `plugin --profile orcana add --save-exact ${ORCANA_RUNTIME_PACKAGES.join(' ')}`,
        'plugin --profile orcana add --save-exact @leooday/dsh-bundle@0.1.0-rc.1',
        'plugin --profile orcana add --save-exact @leooday/dsh-orcana-linux-bundle@0.3.0',
        '--profile orcana --dump-config',
      ])
    })
  })

  it.skipIf(process.platform === 'win32')('runs deterministic Web phases before the composition smoke', () => {
    withFakeLocalToolchain((env, log) => {
      const result = spawnSync('/bin/sh', nativeCompanionInstallShellArgs(
        ['plugin', '--profile', 'orcana-web', 'add',
          '@leooday/dsh-bundle@0.1.0-rc.1',
          '@leooday/dsh-orcana-linux-bundle@0.3.0'],
        DSH_PACKAGE,
        DSH_WEB_APP_PACKAGE,
        VERSION_CONTRACT,
      ), { env, encoding: 'utf8' })
      expect(result.status).toBe(0)
      const calls = readFileSync(log, 'utf8').trim().split('\n')
      expect(calls.slice(-5)).toEqual([
        `plugin --profile orcana-web add --save-exact ${WEB_PACKAGE}`,
        `plugin --profile orcana-web add --save-exact ${ORCANA_RUNTIME_PACKAGES.join(' ')}`,
        'plugin --profile orcana-web add --save-exact @leooday/dsh-bundle@0.1.0-rc.1',
        'plugin --profile orcana-web add --save-exact @leooday/dsh-orcana-linux-bundle@0.3.0',
        '--profile orcana-web --dump-config',
      ])
    })
  })

  it.skipIf(process.platform === 'win32')('preserves the first failing install phase and does not run later phases/smoke', () => {
    withFakeLocalToolchain((env, log) => {
      env.DSH_FAKE_INSTALL_STATUS = '23'
      const result = spawnSync('/bin/sh', nativeInstallShellArgs(INSTALL_ARGS, DSH_PACKAGE, VERSION_CONTRACT), {
        env,
        encoding: 'utf8',
      })
      expect(result.status).toBe(23)
      const calls = readFileSync(log, 'utf8').trim().split('\n')
      expect(calls.filter(call => call.startsWith('plugin '))).toHaveLength(1)
      expect(calls).not.toContain('--profile orcana --dump-config')
    })
  })

  it.skipIf(process.platform === 'win32')('fails loud when install succeeds but profile composition is broken', () => {
    withFakeLocalToolchain((env, log) => {
      env.DSH_FAKE_SMOKE_STATUS = '31'
      const result = spawnSync('/bin/sh', nativeInstallShellArgs(INSTALL_ARGS, DSH_PACKAGE, VERSION_CONTRACT), {
        env,
        encoding: 'utf8',
      })
      expect(result.status).toBe(31)
      expect(result.stderr).toContain('composition smoke failed for profile=orcana')
      const calls = readFileSync(log, 'utf8').trim().split('\n')
      expect(calls.at(-1)).toBe('--profile orcana --dump-config')
    })
  })

  it('builds headless and Web WSL executions with the same pinned toolchain', () => {
    const headless = buildWslInstallArgs(
      '/mnt/c/work tree',
      ['plugin', '--profile', 'orcana', 'add', '@leooday/dsh-bundle@0.1.0-rc.1'],
      DSH_PACKAGE,
      VERSION_CONTRACT,
      'Ubuntu-24.04',
    )
    const web = buildWslCompanionInstallArgs(
      '/mnt/c/work tree',
      ['plugin', '--profile', 'orcana-web', 'add', '@leooday/dsh-bundle@0.1.0-rc.1'],
      DSH_PACKAGE,
      DSH_WEB_APP_PACKAGE,
      VERSION_CONTRACT,
      'Ubuntu-24.04',
    )

    for (const args of [headless, web]) {
      expect(args.slice(0, 7)).toEqual([
        '--distribution', 'Ubuntu-24.04',
        '--cd', '/mnt/c/work tree',
        '--exec', '/bin/sh', '-c',
      ])
      expect(args[7]).toBe(INSTALL_RESOLVER_SCRIPT)
      expect(args[9]).toBe(DSH_PACKAGE)
      expect(args[10]).toBe(DEFAULT_WSL_PNPM_PACKAGE)
      expect(args[12]).toBe(INSTALL_NODE_CONTRACT_SCRIPT)
      expect(args[14]).toBe(ORCANA_RUNTIME_PACKAGES.join(' '))
    }
    expect(headless[13]).toBe(HEADLESS_PACKAGE)
    expect(web[13]).toBe(WEB_PACKAGE)
  })
})
