import { describe, expect, it } from 'vitest'
import {
  distroForWindowsWorkspace,
  requiredOrcanaProfileForRun,
  translateDshPluginPathSpecsForWsl,
} from '../src/wsl-launcher.ts'

describe('dsh-orcana product profile authority', () => {
  it('requires the default headless profile for task-style invocations', () => {
    expect(requiredOrcanaProfileForRun([], 'orcana')).toBe('headless')
    expect(requiredOrcanaProfileForRun(['fix the tests'], 'orcana')).toBe('headless')
    expect(requiredOrcanaProfileForRun([
      '--patch', './extra.yml', 'fix the tests',
    ], 'orcana')).toBe('headless')
    expect(requiredOrcanaProfileForRun(['--dump-config'], 'orcana')).toBe('headless')
  })

  it('requires the Web companion for the web alias or an explicit owned Web profile', () => {
    expect(requiredOrcanaProfileForRun(['web', '--host', '127.0.0.1'], 'orcana')).toBe('web')
    expect(requiredOrcanaProfileForRun([
      '--profile', 'orcana-web', '--help',
    ], 'orcana')).toBe('web')
    expect(requiredOrcanaProfileForRun([
      '--profile=orcana-web', '--dump-config',
    ], 'orcana')).toBe('web')
  })

  it('still verifies the owned headless profile when the caller spells it explicitly', () => {
    expect(requiredOrcanaProfileForRun([
      '--profile', 'orcana', 'fix the tests',
    ], 'orcana')).toBe('headless')
    expect(requiredOrcanaProfileForRun([
      '--profile=orcana', '--patch', './extra.yml', 'fix the tests',
    ], 'orcana')).toBe('headless')
  })

  it('treats another explicit DSH profile as a deliberate escape hatch', () => {
    expect(requiredOrcanaProfileForRun([
      '--profile', 'bench', 'fix the tests',
    ], 'orcana')).toBeUndefined()
    expect(requiredOrcanaProfileForRun([
      '--profile=plain-web', '--help',
    ], 'orcana')).toBeUndefined()
  })

  it('keeps root management/help/version commands transparent', () => {
    expect(requiredOrcanaProfileForRun(['plugin', '--profile', 'dev', 'list'], 'orcana')).toBeUndefined()
    expect(requiredOrcanaProfileForRun(['--help'], 'orcana')).toBeUndefined()
    expect(requiredOrcanaProfileForRun(['-h'], 'orcana')).toBeUndefined()
    expect(requiredOrcanaProfileForRun(['--version'], 'orcana')).toBeUndefined()
    expect(requiredOrcanaProfileForRun(['-V'], 'orcana')).toBeUndefined()
  })
})

describe('Windows WSL execution-world selection', () => {
  it('uses a WSL UNC cwd as the execution distro when no selector was provided', () => {
    expect(distroForWindowsWorkspace('\\\\wsl.localhost\\Ubuntu\\home\\leo\\repo')).toBe('Ubuntu')
    expect(distroForWindowsWorkspace('\\\\wsl$\\Debian\\srv\\repo')).toBe('Debian')
    expect(distroForWindowsWorkspace('C:\\repo')).toBeUndefined()
  })

  it('accepts the same explicit distro case-insensitively and rejects a different one', () => {
    expect(distroForWindowsWorkspace(
      '\\\\wsl.localhost\\Ubuntu\\home\\leo\\repo',
      'ubuntu',
    )).toBe('ubuntu')

    expect(() => distroForWindowsWorkspace(
      '\\\\wsl.localhost\\Ubuntu\\home\\leo\\repo',
      'Debian',
    )).toThrow(/cwd belongs to WSL distro/)
  })
})

describe('Windows dsh plugin path-spec translation', () => {
  it('normalizes only relative filesystem specs while preserving pnpm semantics', () => {
    const result = translateDshPluginPathSpecsForWsl([
      'plugin', '--profile', 'dev', 'add',
      '.\\plugin-a',
      'file:..\\plugin-b',
      'link:.\\plugin-c',
      '@scope/registry-plugin@1.2.3',
      'github:owner/repo',
      '--save-exact',
    ])

    expect(result).toEqual({
      args: [
        'plugin', '--profile', 'dev', 'add',
        './plugin-a',
        'file:../plugin-b',
        'link:./plugin-c',
        '@scope/registry-plugin@1.2.3',
        'github:owner/repo',
        '--save-exact',
      ],
    })
  })

  it('maps absolute Windows specs with wslpath and keeps file/link prefixes', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const fake = ((command: string, args: readonly string[]) => {
      calls.push({ command, args })
      const source = String(args.at(-1))
      const leaf = source.includes('plugin-b') ? 'plugin-b' : 'plugin-a'
      return { status: 0, stdout: `/work/${leaf}\n`, stderr: '', error: undefined }
    }) as unknown as typeof import('node:child_process').spawnSync

    const result = translateDshPluginPathSpecsForWsl([
      'plugin', '--profile=dev', 'add',
      'C:\\repo\\plugin-a',
      'file:D:\\src\\plugin-b',
    ], 'Ubuntu', fake)

    expect(result).toEqual({
      distro: 'Ubuntu',
      args: [
        'plugin', '--profile=dev', 'add',
        '/work/plugin-a',
        'file:/work/plugin-b',
      ],
    })
    expect(calls).toEqual([
      {
        command: 'wsl.exe',
        args: ['--distribution', 'Ubuntu', '--exec', 'wslpath', '-a', '-u', 'C:\\repo\\plugin-a'],
      },
      {
        command: 'wsl.exe',
        args: ['--distribution', 'Ubuntu', '--exec', 'wslpath', '-a', '-u', 'D:\\src\\plugin-b'],
      },
    ])
  })

  it('can be locked to the WSL UNC cwd distro before translating drive paths', () => {
    const calls: string[][] = []
    const fake = ((_: string, args: readonly string[]) => {
      calls.push([...args])
      return { status: 0, stdout: '/mnt/c/repo/plugin\n', stderr: '', error: undefined }
    }) as unknown as typeof import('node:child_process').spawnSync

    const distro = distroForWindowsWorkspace('\\\\wsl.localhost\\Ubuntu\\home\\leo\\repo')
    translateDshPluginPathSpecsForWsl(
      ['plugin', '--profile', 'dev', 'add', 'C:\\repo\\plugin'],
      distro,
      fake,
    )

    expect(calls[0]).toEqual([
      '--distribution', 'Ubuntu', '--exec', 'wslpath', '-a', '-u', 'C:\\repo\\plugin',
    ])
  })

  it('infers the execution distro from a WSL UNC package spec', () => {
    const result = translateDshPluginPathSpecsForWsl([
      'plugin', '--profile', 'dev', 'add',
      '\\\\wsl.localhost\\Debian\\home\\leo\\plugin',
    ])

    expect(result).toEqual({
      distro: 'Debian',
      args: ['plugin', '--profile', 'dev', 'add', '/home/leo/plugin'],
    })
  })

  it('fails loud when a WSL UNC package belongs to another selected distro', () => {
    expect(() => translateDshPluginPathSpecsForWsl([
      'plugin', '--profile', 'dev', 'add',
      'file:\\\\wsl$\\Debian\\home\\leo\\plugin',
    ], 'Ubuntu')).toThrow(/belongs to WSL distro/)
  })

  it('does not reinterpret task/app arguments that merely look like Windows paths', () => {
    const task = ['--profile', 'orcana', 'fix', '.\\not-a-plugin-spec', 'C:\\literal\\task-text']
    expect(translateDshPluginPathSpecsForWsl(task)).toEqual({ args: task })

    const web = ['web', '--host', '127.0.0.1', '.\\opaque-app-arg']
    expect(translateDshPluginPathSpecsForWsl(web)).toEqual({ args: web })
  })

  it('leaves malformed plugin invocations untouched for DSH to diagnose', () => {
    const args = ['plugin', 'add', '.\\plugin']
    expect(translateDshPluginPathSpecsForWsl(args)).toEqual({ args })
  })
})
