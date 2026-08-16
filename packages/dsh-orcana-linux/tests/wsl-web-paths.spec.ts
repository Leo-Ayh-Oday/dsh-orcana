import { describe, expect, it } from 'vitest'
import {
  inferWslDistroFromDshPathArgs,
  translateDshPathArgsForWsl,
} from '../src/wsl-bridge.ts'

describe('WSL web-command path ownership', () => {
  it('keeps scanning web options so a later --patch remains a DSH-owned path', () => {
    const fake = ((_: string, args: readonly string[]) => ({
      status: 0,
      stdout: args.at(-1) === 'C:\\repo\\web.yml' ? '/mnt/c/repo/web.yml\n' : '/mapped/other\n',
      stderr: '',
      error: undefined,
    })) as unknown as typeof import('node:child_process').spawnSync

    expect(translateDshPathArgsForWsl([
      'web',
      '--host', '127.0.0.1',
      '--port', '3081',
      '--patch', 'C:\\repo\\web.yml',
      '--help',
    ], 'Ubuntu', fake)).toEqual([
      'web',
      '--host', '127.0.0.1',
      '--port', '3081',
      '--patch', '/mnt/c/repo/web.yml',
      '--help',
    ])
  })

  it('can infer the WSL distro from a web --patch that follows unrelated options', () => {
    expect(inferWslDistroFromDshPathArgs([
      'web',
      '--host', '127.0.0.1',
      '--patch', '\\\\wsl.localhost\\Debian\\home\\leo\\web.yml',
    ])).toBe('Debian')
  })
})
