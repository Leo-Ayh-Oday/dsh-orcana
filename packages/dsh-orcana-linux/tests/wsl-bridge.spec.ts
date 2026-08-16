import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WSL_BUNDLES,
  DEFAULT_WSL_DSH_PACKAGE,
  buildWslDshArgs,
  dshArgsForBridge,
  environmentForWsl,
  hostCwdForWslSpawn,
  parseWslBridgeArgs,
  parseWslUncPath,
  windowsPathToWsl,
  windowsWorkspaceKind,
} from '../src/wsl-bridge.ts'

describe('WSL bridge argument contract', () => {
  it('parses only --wsl-* flags and preserves DSH arguments', () => {
    const parsed = parseWslBridgeArgs([
      '--wsl-distro', 'Ubuntu-24.04',
      '--wsl-profile=orcana-dev',
      '--model', 'deepseek',
      'fix the tests',
    ], {})
    expect(parsed).toEqual({
      distro: 'Ubuntu-24.04',
      profile: 'orcana-dev',
      mode: 'run',
      dshArgs: ['--model', 'deepseek', 'fix the tests'],
    })
  })

  it('defaults to the orcana profile but respects an explicit pre-sentinel DSH profile', () => {
    const defaulted = parseWslBridgeArgs(['fix it'], {})
    expect(dshArgsForBridge(defaulted)).toEqual(['--profile', 'orcana', 'fix it'])

    const explicit = parseWslBridgeArgs(['--profile', 'bench', 'fix it'], {})
    expect(dshArgsForBridge(explicit)).toEqual(['--profile', 'bench', 'fix it'])
  })

  it('preserves the -- sentinel and treats everything after it as opaque DSH/task argv', () => {
    const parsed = parseWslBridgeArgs(['--', '--profile', 'literal', '--wsl-distro', 'also-literal'], {})
    expect(parsed.distro).toBeUndefined()
    expect(parsed.dshArgs).toEqual(['--', '--profile', 'literal', '--wsl-distro', 'also-literal'])
    expect(dshArgsForBridge(parsed)).toEqual([
      '--profile', 'orcana', '--', '--profile', 'literal', '--wsl-distro', 'also-literal',
    ])
  })

  it('builds the official one-profile bundle installation', () => {
    const parsed = parseWslBridgeArgs(['--wsl-install'], {})
    expect(dshArgsForBridge(parsed)).toEqual([
      'plugin', '--profile', 'orcana', 'add', ...DEFAULT_WSL_BUNDLES,
    ])
  })

  it('pins the compatible DSH npm fallback and keeps task text out of the resolver script', () => {
    const task = 'echo "$HOME" && rm -rf nope'
    const argv = buildWslDshArgs(
      '/mnt/c/work tree',
      ['--profile', 'orcana', task],
      'Ubuntu',
    )
    expect(argv.slice(0, 7)).toEqual([
      '--distribution', 'Ubuntu',
      '--cd', '/mnt/c/work tree',
      '--exec', '/bin/sh', '-lc',
    ])
    const resolver = argv[7]
    expect(resolver).toContain('command -v dsh')
    expect(resolver).toContain('npx --yes "$package_spec"')
    expect(resolver).not.toContain(task)
    expect(argv[8]).toBe('dsh-orcana')
    expect(argv[9]).toBe(DEFAULT_WSL_DSH_PACKAGE)
    expect(argv.slice(-3)).toEqual(['--profile', 'orcana', task])
  })

  it('allows an explicit compatible DSH package fallback without shell interpolation', () => {
    const argv = buildWslDshArgs('/home/leo/repo', ['web'], 'Ubuntu', undefined, '@deepseek-ai/dsh@0.1.0-rc.99')
    expect(argv[9]).toBe('@deepseek-ai/dsh@0.1.0-rc.99')
    expect(argv.at(-1)).toBe('web')
  })

  it('uses a caller-supplied DSH executable directly without a resolver shell', () => {
    expect(buildWslDshArgs('/home/leo/repo', ['web'], 'Ubuntu', '/opt/dsh')).toEqual([
      '--distribution', 'Ubuntu', '--cd', '/home/leo/repo', '--exec', '/opt/dsh', 'web',
    ])
  })
})

describe('WSL path contract', () => {
  it('maps both WSL UNC dialects without a subprocess', () => {
    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\leo\\repo')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/leo/repo',
    })
    expect(parseWslUncPath('\\\\wsl$\\Debian\\srv\\repo')).toEqual({
      distro: 'Debian',
      linuxPath: '/srv/repo',
    })
  })

  it('uses wslpath instead of assuming /mnt/c', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const fake = ((command: string, args: readonly string[]) => {
      calls.push({ command, args })
      return { status: 0, stdout: '/custom/c/work/repo\n', stderr: '', error: undefined }
    }) as unknown as typeof import('node:child_process').spawnSync

    expect(windowsPathToWsl('C:\\work\\repo', 'Ubuntu', fake)).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/custom/c/work/repo',
    })
    expect(calls[0]).toEqual({
      command: 'wsl.exe',
      args: ['--distribution', 'Ubuntu', '--exec', 'wslpath', '-a', '-u', 'C:\\work\\repo'],
    })
  })

  it('fails loud when a WSL UNC cwd conflicts with the selected distro', () => {
    expect(() => windowsPathToWsl('\\\\wsl$\\Ubuntu\\home\\leo', 'Debian')).toThrow(/belongs to WSL distro/)
  })

  it('does not use a WSL UNC path as the Win32 CreateProcess cwd', () => {
    expect(hostCwdForWslSpawn('C:\\repo', { USERPROFILE: 'C:\\Users\\leo' })).toBe('C:\\repo')
    expect(hostCwdForWslSpawn('\\\\wsl.localhost\\Ubuntu\\home\\leo\\repo', {
      USERPROFILE: 'C:\\Users\\leo',
    })).toBe('C:\\Users\\leo')
    expect(hostCwdForWslSpawn('\\\\wsl$\\Ubuntu\\home\\leo\\repo', {})).toBe('C:\\')
  })

  it('classifies Windows-mounted and WSL-native workspaces for doctor guidance', () => {
    expect(windowsWorkspaceKind('C:\\repo')).toBe('windows-mounted')
    expect(windowsWorkspaceKind('\\\\wsl.localhost\\Ubuntu\\home\\leo\\repo')).toBe('wsl-native')
  })
})

describe('WSL environment contract', () => {
  it('forwards runtime/provider variables one-way into WSL without sharing Windows DSH_HOME', () => {
    const result = environmentForWsl({
      WSLENV: 'EXISTING/u',
      EXISTING: 'x',
      DEEPSEEK_API_KEY: 'secret',
      DEEPSEEK_BASE_URL: 'https://gateway.example.test',
      DSH_TRACE: '1',
      DSH_HOME: 'C:\\Users\\leo\\.dsh',
      ORCANA_MODE: 'warn-steer',
      ORCANA_WSL_DISTRO: 'Ubuntu',
      ORCANA_WSL_DSH_PACKAGE: '@deepseek-ai/dsh@custom',
      PATH: 'C:\\Windows',
    })
    expect(result.WSLENV?.split(':')).toEqual([
      'EXISTING/u',
      'DEEPSEEK_API_KEY/u',
      'DEEPSEEK_BASE_URL/u',
      'DSH_TRACE/u',
      'ORCANA_MODE/u',
    ])
    expect(result.WSLENV).not.toContain('DSH_HOME')
    expect(result.WSLENV).not.toContain('ORCANA_WSL_DISTRO')
    expect(result.WSLENV).not.toContain('ORCANA_WSL_DSH_PACKAGE')
    expect(result.WSLENV).not.toContain('PATH')
  })

  it('supports an explicit extra forward allowlist without leaking invalid names or Windows DSH_HOME', () => {
    const result = environmentForWsl({
      ORCANA_WSL_FORWARD_ENV: 'MY_FLAG,INVALID-NAME,DSH_HOME',
      MY_FLAG: 'yes',
      'INVALID-NAME': 'no',
      DSH_HOME: 'no',
    })
    expect(result.WSLENV).toBe('MY_FLAG/u')
  })
})
