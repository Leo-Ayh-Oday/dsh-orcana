import { describe, expect, it } from 'vitest'
import { translateDshPluginPathSpecsForWsl } from '../src/wsl-launcher.ts'

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
