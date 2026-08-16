import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WSL_DSH_PACKAGE,
  DSH_VERSION_CONTRACT_SCRIPT,
  buildWslDshArgs,
} from '../src/wsl-bridge.ts'

describe('Windows → WSL argv parity', () => {
  it('keeps Unicode, emoji, quotes, backslashes, newlines and shell metacharacters positional', () => {
    const task = '修复这个测试 🚀\n不要展开 $HOME；保留 "双引号"、\'单引号\'、C:\\repo\\a b && echo NO | cat > nope'
    const opaque = '--literal=$PATH;$(touch should-not-run)`id`'
    const args = buildWslDshArgs(
      '/mnt/c/项目 repo',
      ['--profile', 'orcana', '--', task, opaque],
      'Ubuntu-24.04',
    )

    expect(args.slice(0, 7)).toEqual([
      '--distribution', 'Ubuntu-24.04',
      '--cd', '/mnt/c/项目 repo',
      '--exec', '/bin/sh', '-c',
    ])

    const resolver = args[7]!
    expect(resolver).not.toContain(task)
    expect(resolver).not.toContain(opaque)
    expect(args[8]).toBe('dsh-orcana')
    expect(args[9]).toBe(DEFAULT_WSL_DSH_PACKAGE)
    expect(args[10]).toBe(DSH_VERSION_CONTRACT_SCRIPT)
    expect(args.slice(11)).toEqual(['--profile', 'orcana', '--', task, opaque])
  })

  it('does not shell-wrap an explicit WSL-side DSH executable', () => {
    const task = '中文 task with spaces && not-a-shell-expression'
    expect(buildWslDshArgs('/home/leo/repo', [task], 'Ubuntu', '/opt/dsh')).toEqual([
      '--distribution', 'Ubuntu', '--cd', '/home/leo/repo', '--exec', '/opt/dsh', task,
    ])
  })
})
