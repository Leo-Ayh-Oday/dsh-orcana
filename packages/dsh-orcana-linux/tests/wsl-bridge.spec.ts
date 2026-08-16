import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WSL_BUNDLES,
  DEFAULT_WSL_DSH_PACKAGE,
  DSH_VERSION_CONTRACT_SCRIPT,
  buildWslDshArgs,
  dshArgsForBridge,
  environmentForWsl,
  hostCwdForWslSpawn,
  inferWslDistroFromDshPathArgs,
  parseWslBridgeArgs,
  parseWslUncPath,
  shouldInjectDefaultProfile,
  translateDshPathArgsForWsl,
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

  it('injects orcana only for task/profile boot and respects an explicit profile', () => {
    const defaulted = parseWslBridgeArgs(['fix it'], {})
    expect(dshArgsForBridge(defaulted)).toEqual(['--profile', 'orcana', 'fix it'])

    const explicit = parseWslBridgeArgs(['--profile', 'bench', 'fix it'], {})
    expect(dshArgsForBridge(explicit)).toEqual(['--profile', 'bench', 'fix it'])

    const dump = parseWslBridgeArgs(['--dump-config'], {})
    expect(dshArgsForBridge(dump)).toEqual(['--profile', 'orcana', '--dump-config'])
  })

  it.each([
    [['web'], ['web']],
    [['web', '--patch', './web.yml'], ['web', '--patch', './web.yml']],
    [['plugin', '--profile', 'bench', 'add', 'pkg'], ['plugin', '--profile', 'bench', 'add', 'pkg']],
    [['--patch', './invalid-parent.yml', 'web'], ['--patch', './invalid-parent.yml', 'web']],
    [['--version'], ['--version']],
    [['-h'], ['-h']],
  ] as const)('keeps DSH root invocation %j transparent', (input, expected) => {
    const parsed = parseWslBridgeArgs(input, {})
    expect(shouldInjectDefaultProfile(parsed.dshArgs)).toBe(false)
    expect(dshArgsForBridge(parsed)).toEqual(expected)
  })

  it('preserves the -- sentinel and treats everything after it as opaque DSH/task argv', () => {
    const parsed = parseWslBridgeArgs(['--', '--profile', 'literal', '--wsl-distro', 'also-literal'], {})
    expect(parsed.distro).toBeUndefined()
    expect(parsed.dshArgs).toEqual(['--', '--profile', 'literal', '--wsl-distro', 'also-literal'])
    expect(dshArgsForBridge(parsed)).toEqual([
      '--profile', 'orcana', '--', '--profile', 'literal', '--wsl-distro', 'also-literal',
    ])
  })

  it('pins the Orcana bundle release set for --wsl-install', () => {
    expect(DEFAULT_WSL_BUNDLES).toEqual([
      '@leooday/dsh-bundle@0.1.0-rc.1',
      '@leooday/dsh-orcana-linux-bundle@0.2.0',
    ])
    const parsed = parseWslBridgeArgs(['--wsl-install'], {})
    expect(dshArgsForBridge(parsed)).toEqual([
      'plugin', '--profile', 'orcana', 'add', ...DEFAULT_WSL_BUNDLES,
    ])
  })

  it('requires auto-discovered dsh to exactly match the pinned npm package', () => {
    const task = 'echo "$HOME" && rm -rf nope'
    const argv = buildWslDshArgs(
      '/mnt/c/work tree',
      ['--profile', 'orcana', task],
      'Ubuntu',
    )
    expect(argv.slice(0, 7)).toEqual([
      '--distribution', 'Ubuntu',
      '--cd', '/mnt/c/work tree',
      '--exec', '/bin/sh', '-c',
    ])
    const resolver = argv[7]
    expect(resolver).toContain('dsh --version')
    expect(resolver).toContain('node -e "$dsh_contract" "$package_spec" "$installed_version"')
    expect(resolver).toContain('npx --yes "$package_spec"')
    expect(resolver).not.toContain(task)
    expect(argv[8]).toBe('dsh-orcana')
    expect(argv[9]).toBe(DEFAULT_WSL_DSH_PACKAGE)
    expect(argv[10]).toBe(DSH_VERSION_CONTRACT_SCRIPT)
    expect(argv.slice(-3)).toEqual(['--profile', 'orcana', task])
  })

  it.each([
    ['@deepseek-ai/dsh@0.1.0-rc.5', '0.1.0-rc.5', true],
    ['@deepseek-ai/dsh@0.1.0-rc.5', '0.1.0-rc.6', false],
    ['@deepseek-ai/dsh@0.1.0-rc.5', '0.1.0', false],
    ['@deepseek-ai/dsh@0.1.0-rc.6', '0.1.0-rc.6', true],
    ['@deepseek-ai/dsh@latest', '0.1.0-rc.6', false],
    ['garbage', '0.1.0-rc.5', false],
  ] as const)('matches package %s to installed DSH %s => %s', (packageSpec, version, compatible) => {
    const result = spawnSync(process.execPath, ['-e', DSH_VERSION_CONTRACT_SCRIPT, packageSpec, version], {
      stdio: 'ignore',
    })
    expect(result.status === 0).toBe(compatible)
  })

  it('allows an explicit DSH npm fallback package without shell interpolation', () => {
    const argv = buildWslDshArgs('/home/leo/repo', ['web'], 'Ubuntu', undefined, '@deepseek-ai/dsh@0.1.0-rc.6')
    expect(argv[9]).toBe('@deepseek-ai/dsh@0.1.0-rc.6')
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

  it('fails loud when a WSL UNC path conflicts with the selected distro', () => {
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

  it('infers a distro only from DSH-owned WSL UNC path arguments', () => {
    expect(inferWslDistroFromDshPathArgs([
      '--profile', 'orcana',
      '--patch', '\\\\wsl.localhost\\Debian\\home\\leo\\one.yml',
      'task',
      '--patch', '\\\\wsl.localhost\\Ubuntu\\home\\leo\\opaque.yml',
    ])).toBe('Debian')

    expect(inferWslDistroFromDshPathArgs([
      '--profile', 'orcana',
      'please inspect \\\\wsl.localhost\\Debian\\home\\leo\\repo',
    ])).toBeUndefined()
  })

  it('fails loud when launcher-owned path arguments span multiple WSL distros', () => {
    expect(() => inferWslDistroFromDshPathArgs([
      '--profile', 'orcana',
      '--patch', '\\\\wsl.localhost\\Ubuntu\\home\\leo\\one.yml',
      '--patch', '\\\\wsl.localhost\\Debian\\home\\leo\\two.yml',
      'task',
    ])).toThrow(/span multiple WSL distros/)
  })

  it('translates only DSH-owned --patch paths and leaves task argv opaque', () => {
    const fake = ((_: string, args: readonly string[]) => ({
      status: 0,
      stdout: args.at(-1) === 'C:\\repo\\one.yml' ? '/mnt/c/repo/one.yml\n' : '/mapped/other\n',
      stderr: '',
      error: undefined,
    })) as unknown as typeof import('node:child_process').spawnSync

    expect(translateDshPathArgsForWsl([
      '--profile', 'orcana',
      '--patch', 'C:\\repo\\one.yml',
      '--patch=.\\two.yml',
      'task',
      '--patch', 'C:\\do-not-touch.yml',
    ], 'Ubuntu', fake)).toEqual([
      '--profile', 'orcana',
      '--patch', '/mnt/c/repo/one.yml',
      '--patch=./two.yml',
      'task',
      '--patch', 'C:\\do-not-touch.yml',
    ])

    expect(translateDshPathArgsForWsl(['web', '--patch', '.\\web.yml', '--help'], 'Ubuntu', fake)).toEqual([
      'web', '--patch', './web.yml', '--help',
    ])
  })
})

describe('WSL environment contract', () => {
  it('normalizes owned WSLENV direction while blocking Windows runtime-home contamination', () => {
    const result = environmentForWsl({
      WSLENV: 'EXISTING/u:DEEPSEEK_API_KEY/w:DSH_HOME/u:ORCANA_WSL_DISTRO/u:MY_PATH/pw',
      EXISTING: 'x',
      DEEPSEEK_API_KEY: 'secret',
      DEEPSEEK_BASE_URL: 'https://gateway.example.test',
      DSH_TRACE: '1',
      DSH_HOME: 'C:\\Users\\leo\\.dsh',
      ORCANA_MODE: 'warn-steer',
      ORCANA_WSL_DISTRO: 'Ubuntu',
      ORCANA_WSL_DSH_PACKAGE: '@deepseek-ai/dsh@custom',
      ORCANA_WSL_FORWARD_ENV: 'MY_PATH',
      MY_PATH: 'C:\\toolchain',
      PATH: 'C:\\Windows',
    })
    const rows = result.WSLENV?.split(':') ?? []
    expect(rows).toEqual([
      'EXISTING/u',
      'DEEPSEEK_API_KEY/u',
      'MY_PATH/pu',
      'DEEPSEEK_BASE_URL/u',
      'DSH_TRACE/u',
      'ORCANA_MODE/u',
    ])
    const names = rows.map((entry) => entry.split('/', 1)[0])
    expect(names).not.toContain('DSH_HOME')
    expect(names).not.toContain('ORCANA_WSL_DISTRO')
    expect(names).not.toContain('ORCANA_WSL_DSH_PACKAGE')
    expect(names).not.toContain('PATH')
  })

  it('repairs an invalid/reverse existing row for an explicitly forwarded scalar', () => {
    const result = environmentForWsl({
      WSLENV: 'MY_FLAG/zw:UNRELATED/lw',
      ORCANA_WSL_FORWARD_ENV: 'MY_FLAG',
      MY_FLAG: 'yes',
      UNRELATED: 'C:\\a;C:\\b',
    })
    expect(result.WSLENV).toBe('MY_FLAG/u:UNRELATED/lw')
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
