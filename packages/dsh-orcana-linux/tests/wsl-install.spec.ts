import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WSL_PNPM_PACKAGE,
  INSTALL_RESOLVER_SCRIPT,
  buildWslInstallArgs,
  nativeInstallShellArgs,
} from '../src/wsl-install.ts'

const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.5'
const VERSION_CONTRACT = 'fixed version contract'

describe('WSL plugin-install toolchain', () => {
  it('pins the pnpm version declared by the current DSH release family', () => {
    expect(DEFAULT_WSL_PNPM_PACKAGE).toBe('pnpm@11.7.0')
  })

  it('uses matching local dsh+pnpm when available and otherwise bootstraps both through npx', () => {
    expect(INSTALL_RESOLVER_SCRIPT).toContain('dsh --version')
    expect(INSTALL_RESOLVER_SCRIPT).toContain('pnpm --version')
    expect(INSTALL_RESOLVER_SCRIPT).toContain('node -e "$version_contract" "$dsh_package" "$dsh_version"')
    expect(INSTALL_RESOLVER_SCRIPT).toContain('node -e "$version_contract" "$pnpm_package" "$pnpm_version"')
    expect(INSTALL_RESOLVER_SCRIPT).toContain('exec npx --yes --package="$pnpm_package" --package="$dsh_package" -- dsh "$@"')
  })

  it('keeps plugin arguments positional and out of the fixed resolver script', () => {
    const packageName = '@leooday/dsh-orcana-linux-bundle; echo should-not-run'
    const args = nativeInstallShellArgs(
      ['plugin', '--profile', 'orcana', 'add', packageName],
      DSH_PACKAGE,
      VERSION_CONTRACT,
    )

    expect(args.slice(0, 7)).toEqual([
      '-c', INSTALL_RESOLVER_SCRIPT, 'dsh-orcana-install',
      DSH_PACKAGE, DEFAULT_WSL_PNPM_PACKAGE, VERSION_CONTRACT,
      'plugin',
    ])
    expect(INSTALL_RESOLVER_SCRIPT).not.toContain(packageName)
    expect(args.at(-1)).toBe(packageName)
  })

  it('builds one WSL execution with mapped cwd and the same pinned toolchain', () => {
    const args = buildWslInstallArgs(
      '/mnt/c/work tree',
      ['plugin', '--profile', 'orcana', 'add', '@leooday/dsh-bundle'],
      DSH_PACKAGE,
      VERSION_CONTRACT,
      'Ubuntu-24.04',
    )

    expect(args.slice(0, 7)).toEqual([
      '--distribution', 'Ubuntu-24.04',
      '--cd', '/mnt/c/work tree',
      '--exec', '/bin/sh', '-c',
    ])
    expect(args[7]).toBe(INSTALL_RESOLVER_SCRIPT)
    expect(args[9]).toBe(DSH_PACKAGE)
    expect(args[10]).toBe(DEFAULT_WSL_PNPM_PACKAGE)
    expect(args.at(-1)).toBe('@leooday/dsh-bundle')
  })
})
