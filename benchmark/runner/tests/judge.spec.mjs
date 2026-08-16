/**
 * Judge unit tests: completion-claim heuristic and the verdict matrix.
 */
import { describe, expect, it } from 'vitest'
import { claimedCompletion, judgeVerdict } from '../judge.mjs'

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
