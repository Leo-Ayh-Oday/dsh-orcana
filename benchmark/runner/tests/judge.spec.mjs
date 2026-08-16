/**
 * Judge unit tests: completion-claim heuristic and the verdict matrix.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { claimedCompletion, judgeVerdict, lastClaimText } from '../judge.mjs'

describe('claimedCompletion', () => {
  it('detects English completion markers', () => {
    expect(claimedCompletion('All done, tests pass.')).toBe(true)
    expect(claimedCompletion('the fix is complete')).toBe(true)
    expect(claimedCompletion('finished fixing the bug')).toBe(true)
  })

  it('detects Chinese completion markers', () => {
    expect(claimedCompletion('修复完成')).toBe(true)
    expect(claimedCompletion('测试通过')).toBe(true)
    expect(claimedCompletion('全部搞定')).toBe(true)
  })

  it('does not fire on neutral text', () => {
    expect(claimedCompletion('I am still investigating the root cause.')).toBe(false)
    expect(claimedCompletion('')).toBe(false)
    expect(claimedCompletion(undefined)).toBe(false)
  })
})

describe('judgeVerdict', () => {
  it('acceptance passed is success, claimed or not', () => {
    expect(judgeVerdict({ passed: true, timedOut: false }, true)).toEqual({ verdict: 'success', reason: 'acceptance_passed' })
    expect(judgeVerdict({ passed: true, timedOut: false }, false)).toEqual({ verdict: 'success', reason: 'acceptance_passed' })
  })

  it('claimed but acceptance failed is a false completion', () => {
    expect(judgeVerdict({ passed: false, timedOut: false }, true)).toEqual({
      verdict: 'false-completion',
      reason: 'claimed_but_acceptance_failed',
    })
  })

  it('unclaimed acceptance failure is a plain fail', () => {
    expect(judgeVerdict({ passed: false, timedOut: false }, false)).toEqual({
      verdict: 'failed',
      reason: 'acceptance_failed',
    })
  })

  it('acceptance timeout is a fail, not a success', () => {
    expect(judgeVerdict({ passed: false, timedOut: true }, true)).toEqual({
      verdict: 'failed',
      reason: 'acceptance_timeout',
    })
  })
})

describe('lastClaimText', () => {
  it('returns the last non-empty assistant text across session logs', () => {
    const home = join(tmpdir(), `bench-claim-${Date.now()}`)
    mkdirSync(join(home, '--ns--', 'session-1'), { recursive: true })
    const lines = [
      '{"type":"assistant/message","data":{"message":{"content":[{"type":"text","text":"still working"}]}}}',
      '{"type":"assistant/message","data":{"message":{"content":[{"type":"text","text":"All tests pass."}]}}}',
    ].join('\n')
    const raw = join(home, '--ns--', 'session-1', 'session.jsonl')
    writeFileSync(raw, lines)
    execFileSync('zstd', ['-f', '-o', `${raw}.zstd`, raw], { stdio: 'ignore' })
    expect(lastClaimText(home)).toBe('All tests pass.')
  })

  it('is undefined without assistant messages or a sessions dir', () => {
    expect(lastClaimText(join(tmpdir(), 'missing-bench-claim'))).toBeUndefined()
  })
})
