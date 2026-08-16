import { describe, expect, it } from 'vitest'
import {
  inferWslDistroFromDshPathArgs,
  translateDshPathArgsForWsl,
} from '../src/wsl-bridge.ts'

describe('WSL web-command path ownership', () => {
  const fake = ((_: string, args: readonly string[]) => ({
    status: 0,
    stdout: args.at(-1) === 'C:\\repo\\web.yml' ? '/mnt/c/repo/web.yml\n' : '/mapped/other\n',
    stderr: '',
    error: undefined,
  })) as unknown as typeof import('node:child_process').spawnSync

  it('translates a launcher-owned web --patch before the first app argument', () => {
    expect(translateDshPathArgsForWsl([
      'web',
      '--patch', 'C:\\repo\\web.yml',
      '--host', '127.0.0.1',
      '--port', '3081',
    ], 'Ubuntu', fake)).toEqual([
      'web',
      '--patch', '/mnt/c/repo/web.yml',
      '--host', '127.0.0.1',
      '--port', '3081',
    ])
  })

  it('stops at the first web-app argument and leaves later --patch text opaque', () => {
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
      '--patch', 'C:\\repo\\web.yml',
      '--help',
    ])
  })

  it('infers a distro only while --patch still belongs to the web launcher', () => {
    expect(inferWslDistroFromDshPathArgs([
      'web',
      '--patch', '\\\\wsl.localhost\\Debian\\home\\leo\\web.yml',
      '--host', '127.0.0.1',
    ])).toBe('Debian')

    expect(inferWslDistroFromDshPathArgs([
      'web',
      '--host', '127.0.0.1',
      '--patch', '\\\\wsl.localhost\\Debian\\home\\leo\\opaque.yml',
    ])).toBeUndefined()
  })
})
