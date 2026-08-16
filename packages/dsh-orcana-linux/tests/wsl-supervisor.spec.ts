import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  SUPERVISOR_NODE_SCRIPT,
  buildWslSupervisedDshArgs,
} from '../src/wsl-supervisor.ts'

function supportsRequiredNode(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return (major === 22 && minor >= 19) || major >= 24
}

describe('WSL supervisor argv contract', () => {
  it('keeps task text positional and forces a stable CommonJS node -e runtime', () => {
    const task = 'echo "$HOME" && rm -rf nope'
    const resolver = 'fixed resolver script'
    const argv = buildWslSupervisedDshArgs(
      '/mnt/c/work tree',
      ['--profile', 'orcana', task],
      '@deepseek-ai/dsh@0.1.0-rc.5',
      resolver,
      'Ubuntu-24.04',
    )

    expect(argv.slice(0, 9)).toEqual([
      '--distribution', 'Ubuntu-24.04',
      '--cd', '/mnt/c/work tree',
      '--exec', 'node', '--input-type=commonjs', '-e', SUPERVISOR_NODE_SCRIPT,
    ])
    expect(SUPERVISOR_NODE_SCRIPT).not.toContain(task)
    expect(argv.slice(9)).toEqual([
      '@deepseek-ai/dsh@0.1.0-rc.5',
      '',
      resolver,
      '--profile', 'orcana', task,
    ])
  })

  it('passes an explicit WSL-side dsh executable as data rather than shell text', () => {
    const argv = buildWslSupervisedDshArgs(
      '/home/leo/repo',
      ['web'],
      '@deepseek-ai/dsh@0.1.0-rc.5',
      'resolver',
      undefined,
      '/opt/dsh',
    )
    expect(argv.slice(0, 6)).toEqual([
      '--cd', '/home/leo/repo', '--exec', 'node', '--input-type=commonjs', '-e',
    ])
    expect(argv.at(-4)).toBe('@deepseek-ai/dsh@0.1.0-rc.5')
    expect(argv.at(-3)).toBe('/opt/dsh')
    expect(argv.at(-1)).toBe('web')
  })

  it('pins the process-tree primitive in the fixed supervisor implementation', () => {
    expect(SUPERVISOR_NODE_SCRIPT).toContain('detached: true')
    expect(SUPERVISOR_NODE_SCRIPT).toContain('process.kill(-child.pid, signal)')
    expect(SUPERVISOR_NODE_SCRIPT).toContain('process.on("SIGINT", onInt)')
  })
})

describe('WSL supervisor Linux process-group integration', () => {
  it.skipIf(process.platform !== 'linux' || !supportsRequiredNode())(
    'relays SIGINT to the detached Linux process group and preserves its exit code',
    async () => {
      const childScript = [
        'trap "exit 42" INT',
        'i=0',
        'while [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done',
        'exit 99',
      ].join('; ')

      const supervisor = spawn(process.execPath, [
        '--input-type=commonjs', '-e', SUPERVISOR_NODE_SCRIPT,
        '@deepseek-ai/dsh@0.1.0-rc.5',
        '/bin/sh',
        'unused resolver',
        '-c', childScript,
      ], {
        stdio: 'ignore',
      })

      const resultPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        supervisor.once('error', reject)
        supervisor.once('close', (code, signal) => resolve({ code, signal }))
      })

      await new Promise<void>((resolve) => setTimeout(resolve, 150))
      supervisor.kill('SIGINT')
      const result = await resultPromise

      expect(result).toEqual({ code: 42, signal: null })
    },
    5_000,
  )
})
