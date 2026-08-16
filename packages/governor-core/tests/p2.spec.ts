/**
 * P2 unit tests: turn-level aggregation, the zero-progress chain, tiered
 * steer text (stable model-visible strings), and the in-round repeat
 * reminder.
 */
import { describe, expect, it } from 'vitest'
import {
  GENTLE_TURN_REMINDER,
  INLINE_REPEAT_REMINDER,
  ProgressFactEngine,
  REEVALUATE_TURN_REMINDER,
  gentleTurnReminder,
  reevaluateTurnReminder,
  steerText,
  strongTurnReminder,
} from '../src/index.ts'
import type { EngineEvent } from '../src/index.ts'

function event(partial: Partial<EngineEvent> & Pick<EngineEvent, 'tool'>): EngineEvent {
  return {
    callId: 'c1',
    canonicalArgs: '{}',
    command: undefined,
    resultHash: 'h1',
    isError: false,
    mutation: false,
    exitCode: undefined,
    interrupted: false,
    ...partial,
  }
}

const READ_A = event({ tool: 'read', canonicalArgs: '{"path":"a"}', resultHash: 'r1' })
const READ_A_AGAIN: EngineEvent = { ...READ_A, callId: 'c2' }
const READ_B = event({ tool: 'read', canonicalArgs: '{"path":"b"}', resultHash: 'r1' })
const WRITE = event({ tool: 'write', canonicalArgs: '{"path":"a","content":"x"}', resultHash: 'w1', mutation: true })
const TEST = (hash: string, exitCode: number | undefined, callId = 'c' + hash): EngineEvent => event({
  tool: 'bash',
  canonicalArgs: '{"command":"npm test"}',
  command: 'npm test',
  resultHash: hash,
  exitCode,
  callId,
})

const THRESHOLDS = [2, 3, 4]

describe('turn aggregation (endTurn)', () => {
  it('a round of only repeats of an already-seen call is zero-progress', () => {
    const engine = new ProgressFactEngine()
    // Round 1: first look at A is activity (first-observation counts as significant).
    engine.applyEvent(READ_A)
    expect(engine.endTurn()).toMatchObject({ zeroProgress: false, chainLength: 0 })
    // Round 2: A is already known; repeating it is zero-progress.
    engine.applyEvent(READ_A)
    engine.applyEvent(READ_A_AGAIN)
    expect(engine.endTurn()).toMatchObject({ zeroProgress: true, chainLength: 1 })
  })

  it('a mutation makes the round progress — the mutation flag itself carries it', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.endTurn() // A is now known
    // A round of pure repeats PLUS a mutation: never zero-progress, and the
    // verdict no longer relies on the observation classifying as progress.
    engine.applyEvent(READ_A)
    engine.applyEvent(READ_A_AGAIN)
    engine.applyEvent(WRITE)
    expect(engine.endTurn()).toMatchObject({ zeroProgress: false, chainLength: 0 })
  })

  it('the same round without the mutation stays zero-progress (flag is load-bearing)', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.endTurn()
    engine.applyEvent(READ_A)
    engine.applyEvent(READ_A_AGAIN)
    expect(engine.endTurn()).toMatchObject({ zeroProgress: true, chainLength: 1 })
  })

  it('a mutation whose observation classifies as repeated still counts as progress', () => {
    // The one path where the mutation flag is load-bearing: the SAME
    // fingerprint was observed WITHOUT the flag first (no gen advance), so
    // the later mutation observation classifies as repeated — significant is
    // never set, and only turn.mutation carries the round.
    const engine = new ProgressFactEngine()
    const writeNoMutation = event({
      tool: 'write',
      canonicalArgs: '{"path":"a","content":"x"}',
      resultHash: 'w1',
    })
    engine.applyEvent(writeNoMutation)
    engine.endTurn() // round 1: first look (progress)
    const writeMutation = event({
      tool: 'write',
      canonicalArgs: '{"path":"a","content":"x"}',
      resultHash: 'w1',
      mutation: true,
    })
    expect(engine.applyEvent(writeMutation)).toEqual({ kind: 'repeated-observation' })
    expect(engine.endTurn()).toMatchObject({ zeroProgress: false, chainLength: 0 })
    // Without the flag the identical round is zero-progress.
    const twin = new ProgressFactEngine()
    twin.applyEvent(writeNoMutation)
    twin.endTurn()
    twin.applyEvent(writeNoMutation)
    expect(twin.endTurn()).toMatchObject({ zeroProgress: true, chainLength: 1 })
  })

  it('new evidence (changed result) makes the round progress', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"path":"a"}', resultHash: 'r2' }))
    expect(engine.endTurn()).toMatchObject({ zeroProgress: false, chainLength: 0 })
  })

  it('the chain accumulates consecutive zero-progress rounds and resets on progress', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.endTurn() // round 1: first look, progress
    engine.applyEvent(READ_A); engine.applyEvent(READ_A_AGAIN)
    expect(engine.endTurn().chainLength).toBe(1)
    engine.applyEvent(READ_A); engine.applyEvent(READ_A_AGAIN)
    expect(engine.endTurn().chainLength).toBe(2)
    engine.applyEvent(READ_B)
    expect(engine.endTurn().chainLength).toBe(0)
    engine.applyEvent(READ_A); engine.applyEvent(READ_A_AGAIN)
    expect(engine.endTurn().chainLength).toBe(1)
  })

  it('an empty round leaves the chain untouched', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.endTurn()
    engine.applyEvent(READ_A); engine.applyEvent(READ_A_AGAIN)
    engine.endTurn()
    expect(engine.zeroProgressChain()).toBe(1)
    expect(engine.endTurn().zeroProgress).toBe(false)
    expect(engine.zeroProgressChain()).toBe(1)
  })

  it('resetChains clears the chain and round state', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.endTurn()
    engine.applyEvent(READ_A); engine.applyEvent(READ_A_AGAIN)
    engine.endTurn()
    engine.applyEvent(READ_A); engine.applyEvent(READ_A_AGAIN)
    engine.endTurn()
    expect(engine.zeroProgressChain()).toBe(2)
    engine.resetChains()
    expect(engine.zeroProgressChain()).toBe(0)
  })
})

describe('verification-repeat special case', () => {
  it('a first-ever verification is progress; re-running it without a pass is zero-progress', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(TEST('t1', 1))
    expect(engine.endTurn()).toMatchObject({ zeroProgress: false, chainLength: 0 })
    engine.applyEvent(TEST('t2', 1))
    expect(engine.endTurn()).toMatchObject({ zeroProgress: true, chainLength: 1 })
    // Even though the output hash changed (timestamps), the re-run is not progress.
    engine.applyEvent(TEST('t3', 1))
    expect(engine.endTurn()).toMatchObject({ zeroProgress: true, chainLength: 2 })
  })

  it('a pass receipt makes the round progress', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(TEST('t1', 1))
    engine.endTurn()
    engine.applyEvent(TEST('t2', 0))
    expect(engine.endTurn()).toMatchObject({ zeroProgress: false, chainLength: 0 })
  })

  it('a mutation between failing re-runs makes the round progress', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(TEST('t1', 1))
    engine.endTurn()
    engine.applyEvent(WRITE)
    engine.applyEvent(TEST('t2', 1))
    expect(engine.endTurn()).toMatchObject({ zeroProgress: false, chainLength: 0 })
  })

  it('mixed evidence: repeated verification plus new non-verification evidence is progress', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(TEST('t1', 1))
    engine.endTurn()
    engine.applyEvent(TEST('t2', 1))
    engine.applyEvent(READ_B)
    expect(engine.endTurn()).toMatchObject({ zeroProgress: false, chainLength: 0 })
  })
})

describe('steer text (stable model-visible strings)', () => {
  it('tiered texts by threshold index', () => {
    expect(steerText(2, undefined, THRESHOLDS)).toBe(GENTLE_TURN_REMINDER)
    expect(steerText(3, undefined, THRESHOLDS)).toBe(REEVALUATE_TURN_REMINDER)
    expect(steerText(4, undefined, THRESHOLDS)).toContain('4 consecutive rounds')
    expect(steerText(4, undefined, THRESHOLDS)).toContain('Change approach or finish the task.')
  })

  it('the strong steer names the repeated pattern', () => {
    const text = strongTurnReminder(5, { tool: 'read', canonicalArgs: '{"path":"a"}' })
    expect(text).toBe(
      'You have spent 5 consecutive rounds without progress. Repeated pattern: read {"path":"a"} Change approach or finish the task.',
    )
  })

  it('custom thresholds remap the tiers, counting the actual chain length', () => {
    expect(steerText(3, undefined, [3, 5])).toBe(gentleTurnReminder(3))
    expect(steerText(5, undefined, [3, 5])).toBe(reevaluateTurnReminder(5))
    expect(steerText(6, undefined, [3, 5])).toContain('6 consecutive rounds')
  })
})

describe('in-round repeat reminder', () => {
  it('fires once per round after the threshold of consecutive same-call repeats', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    expect(engine.consumeInlineReminder()).toBeUndefined()
    engine.applyEvent(READ_A_AGAIN)
    expect(engine.consumeInlineReminder()).toBe(INLINE_REPEAT_REMINDER)
    // Consumed once: a third repeat does not re-raise within the round.
    engine.applyEvent({ ...READ_A, callId: 'c3' })
    expect(engine.consumeInlineReminder()).toBeUndefined()
  })

  it('a different call or a changed result breaks the streak; outside tools never remind', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.applyEvent(READ_B)
    engine.applyEvent(READ_A)
    expect(engine.consumeInlineReminder()).toBeUndefined()
    // A-A pairs: the second consecutive A now crosses the threshold.
    engine.applyEvent(READ_A)
    expect(engine.consumeInlineReminder()).toBe(INLINE_REPEAT_REMINDER)
    // A changed result hash breaks the streak.
    engine.applyEvent(READ_A)
    engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"path":"a"}', resultHash: 'r2' }))
    expect(engine.consumeInlineReminder()).toBeUndefined()
    // Tools outside the inline set never remind.
    const writeRepeat = event({ tool: 'write', canonicalArgs: '{"path":"a"}', resultHash: 'w', callId: 'w1' })
    const writeRepeat2 = event({ tool: 'write', canonicalArgs: '{"path":"a"}', resultHash: 'w', callId: 'w2' })
    engine.applyEvent(writeRepeat)
    engine.applyEvent(writeRepeat2)
    expect(engine.consumeInlineReminder()).toBeUndefined()
  })

  it('the reminder resets on the next round', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.applyEvent(READ_A_AGAIN)
    engine.consumeInlineReminder()
    engine.endTurn()
    engine.applyEvent(READ_A)
    engine.applyEvent(READ_A_AGAIN)
    expect(engine.consumeInlineReminder()).toBe(INLINE_REPEAT_REMINDER)
  })
})

describe('repeatedPattern for the strong steer', () => {
  it('records the last repeated observation of the round', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.applyEvent(READ_A_AGAIN)
    const verdict = engine.endTurn()
    expect(verdict.repeatedPattern).toEqual({ tool: 'read', canonicalArgs: '{"path":"a"}' })
  })
})