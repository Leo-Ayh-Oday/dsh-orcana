/**
 * Progress-fact engine unit tests: ring classification, verification
 * recognition, receipt lifecycle, snapshot/restore, and the live-vs-replay
 * consistency contract (rebuild from events must equal the live fold).
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VERIFY_PATTERNS,
  ProgressFactEngine,
  canonicalizeArgs,
  classifyObservation,
  isVerificationCommand,
  matchesVerificationPattern,
  receiptStatus,
  sha256,
  verificationToken,
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

const READ_A: EngineEvent = event({ tool: 'read', canonicalArgs: '{"path":"a"}', resultHash: 'r1' })
const READ_A_AGAIN: EngineEvent = event({ tool: 'read', canonicalArgs: '{"path":"a"}', resultHash: 'r1' })
const READ_A_CHANGED: EngineEvent = event({ tool: 'read', canonicalArgs: '{"path":"a"}', resultHash: 'r2' })
const READ_B: EngineEvent = event({ tool: 'read', canonicalArgs: '{"path":"b"}', resultHash: 'r1' })
const WRITE: EngineEvent = event({ tool: 'write', canonicalArgs: '{"path":"a","content":"x"}', resultHash: 'w1', mutation: true })
const TEST_FAIL: EngineEvent = event({
  tool: 'bash',
  canonicalArgs: '{"command":"npm test"}',
  command: 'npm test',
  resultHash: 't1',
  exitCode: 1,
})
const TEST_PASS: EngineEvent = event({
  tool: 'bash',
  canonicalArgs: '{"command":"npm test"}',
  command: 'npm test',
  resultHash: 't2',
  exitCode: undefined,
})

describe('classifyObservation (ring semantics)', () => {
  it('first observation of a generation is first-observation', () => {
    expect(classifyObservation([], { tool: 'read', canonicalArgs: '{}', resultHash: 'h' }, 0))
      .toEqual({ kind: 'first-observation' })
  })

  it('a generation advance invalidates older fingerprints', () => {
    const history = [{ tool: 'read', canonicalArgs: '{}', resultHash: 'h', generation: 0 }]
    expect(classifyObservation(history, { tool: 'read', canonicalArgs: '{}', resultHash: 'h' }, 1))
      .toEqual({ kind: 'first-observation' })
  })

  it('identical call within the window is a repeated observation', () => {
    const history = [{ tool: 'read', canonicalArgs: '{}', resultHash: 'h', generation: 0 }]
    expect(classifyObservation(history, { tool: 'read', canonicalArgs: '{}', resultHash: 'h' }, 0))
      .toEqual({ kind: 'repeated-observation' })
  })

  it('same call with a new result is new evidence', () => {
    const history = [{ tool: 'read', canonicalArgs: '{}', resultHash: 'h1', generation: 0 }]
    expect(classifyObservation(history, { tool: 'read', canonicalArgs: '{}', resultHash: 'h2' }, 0))
      .toEqual({ kind: 'new-evidence' })
  })

  it('a different call is progress', () => {
    const history = [{ tool: 'read', canonicalArgs: '{"path":"a"}', resultHash: 'h', generation: 0 }]
    expect(classifyObservation(history, { tool: 'read', canonicalArgs: '{"path":"b"}', resultHash: 'h' }, 0))
      .toEqual({ kind: 'progress' })
  })
})

describe('ProgressFactEngine.applyEvent (engine behavior)', () => {
  it('catches alternating repeats (A-B-A) via the ring', () => {
    const engine = new ProgressFactEngine({ fingerprintWindow: 8 })
    expect(engine.applyEvent(READ_A)).toEqual({ kind: 'first-observation' })
    expect(engine.applyEvent(READ_B)).toEqual({ kind: 'progress' })
    expect(engine.applyEvent(READ_A_AGAIN)).toEqual({ kind: 'repeated-observation' })
  })

  it('a mutation advances the generation; the next observation opens a fresh generation', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.applyEvent(WRITE)
    expect(engine.currentGeneration()).toBe(1)
    // Nothing observed at gen 1 yet: never repeated, first observation of the generation.
    expect(engine.applyEvent(READ_A_AGAIN)).toEqual({ kind: 'first-observation' })
    // Now that the fingerprint is at gen 1, a repeat is detected again.
    expect(engine.applyEvent(READ_A_AGAIN)).toEqual({ kind: 'repeated-observation' })
  })

  it('evicts the oldest fingerprint beyond the window', () => {
    const engine = new ProgressFactEngine({ fingerprintWindow: 2 })
    engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":1}' }))
    engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":2}' }))
    engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":3}' }))
    // p:1 was evicted: replaying it is progress, not repeated.
    expect(engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":1}' }))).toEqual({ kind: 'progress' })
  })

  it('a generation advance drops dead fingerprints so the window never shrinks', () => {
    const engine = new ProgressFactEngine({ fingerprintWindow: 4 })
    engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":1}' }))
    engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":2}' }))
    engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":3}' }))
    engine.applyEvent(event({ tool: 'write', canonicalArgs: '{"p":1}', mutation: true }))
    // gen 1: every pre-mutation entry was cleared — the ring itself is empty
    // (the only observable property of the cleanup).
    expect(engine.snapshot().ring).toEqual([])
    // Old calls replay as first-observation (never repeated), and the window
    // is not polluted.
    expect(engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":1}' }))).toEqual({ kind: 'first-observation' })
    engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":2}' }))
    engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":3}' }))
    engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":4}' }))
    // p:1 is still in the window at gen 1 (fourth slot) — replaying it is
    // repeated, which a polluted ring could no longer detect.
    expect(engine.applyEvent(event({ tool: 'read', canonicalArgs: '{"p":1}' }))).toEqual({ kind: 'repeated-observation' })
  })
})

describe('fingerprint primitives (canonicalizeArgs / sha256)', () => {
  it('canonicalizes deep objects regardless of key order', () => {
    expect(canonicalizeArgs({ b: 1, a: { d: 2, c: [3, 4] } }))
      .toBe(canonicalizeArgs({ a: { c: [3, 4], d: 2 }, b: 1 }))
  })

  it('canonicalization is not identity (order still matters for arrays)', () => {
    expect(canonicalizeArgs({ list: [1, 2] })).not.toBe(canonicalizeArgs({ list: [2, 1] }))
  })

  it('produces stable SHA-256 hex digests', () => {
    const digest = sha256('{"command":"npm test"}')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256('{"command":"npm test"}')).toBe(digest)
    expect(sha256('{"command":"npm test"}')).not.toBe(sha256('{"command":"npm run build"}'))
  })
})

describe('verification recognition', () => {
  it('extracts first-verb tokens for package-manager and bare commands', () => {
    expect(verificationToken('bash', 'npm test')).toBe('test')
    expect(verificationToken('bash', 'pnpm run build')).toBe('build')
    expect(verificationToken('bash', 'pnpm run build:all')).toBe('build:all')
    expect(verificationToken('bash', 'npx vitest run')).toBe('vitest')
    expect(verificationToken('bash', '/usr/local/bin/pnpm test --run')).toBe('test')
    expect(verificationToken('bash', 'cargo test')).toBe('cargo')
    expect(verificationToken('bash', 'npm')).toBe('npm')
    expect(verificationToken('bash', undefined)).toBeUndefined()
    expect(verificationToken('read', undefined)).toBeUndefined()
  })

  it('matches exact and segment-prefixed patterns only', () => {
    expect(matchesVerificationPattern('test', 'test')).toBe(true)
    expect(matchesVerificationPattern('build:all', 'build')).toBe(true)
    expect(matchesVerificationPattern('vitest', 'test')).toBe(false)
    expect(matchesVerificationPattern('notest', 'test')).toBe(false)
  })

  it('a grep for the word test is not a verification command', () => {
    expect(isVerificationCommand('bash', 'grep -r test src', [...DEFAULT_VERIFY_PATTERNS])).toBe(false)
    expect(isVerificationCommand('bash', 'npm test', [...DEFAULT_VERIFY_PATTERNS])).toBe(true)
    expect(isVerificationCommand('bash', 'npm run lint', [...DEFAULT_VERIFY_PATTERNS])).toBe(true)
    expect(isVerificationCommand('read', undefined, [...DEFAULT_VERIFY_PATTERNS])).toBe(false)
  })
})

describe('receiptStatus', () => {
  it('interruption dominates even with an exit marker', () => {
    expect(receiptStatus({ interrupted: true, exitCode: 143, isError: false })).toBe('unknown')
  })
  it('an explicit exit marker decides pass/fail', () => {
    expect(receiptStatus({ interrupted: false, exitCode: 0, isError: false })).toBe('pass')
    expect(receiptStatus({ interrupted: false, exitCode: 1, isError: false })).toBe('fail')
  })
  it('without a marker a non-error result is a clean pass; an error is fail', () => {
    expect(receiptStatus({ interrupted: false, exitCode: undefined, isError: false })).toBe('pass')
    expect(receiptStatus({ interrupted: false, exitCode: undefined, isError: true })).toBe('fail')
  })
})

describe('receipts', () => {
  it('records a fail receipt for a failing verification and overwrites per command', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(TEST_FAIL)
    expect(engine.receiptFor('npm test')).toMatchObject({ command: 'npm test', status: 'fail', callId: 'c1' })
    engine.applyEvent(TEST_PASS)
    expect(engine.receiptFor('npm test')?.status).toBe('pass')
  })

  it('a mutation after verification makes the receipt stale', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(TEST_PASS)
    const receipt = engine.receiptFor('npm test')!
    expect(engine.isStale(receipt)).toBe(false)
    engine.applyEvent(WRITE)
    expect(engine.isStale(receipt)).toBe(true)
  })

  it('background and non-verification events never record receipts', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.applyEvent(event({ tool: 'bash', canonicalArgs: '{"command":"sleep 1"}', command: 'sleep 1' }))
    expect(engine.snapshot().receipts).toEqual([])
  })
})

describe('snapshot / restore / rebuild', () => {
  it('snapshot-restore roundtrip preserves state', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(READ_A)
    engine.applyEvent(WRITE)
    engine.applyEvent(TEST_FAIL)
    const restored = new ProgressFactEngine()
    restored.restore(engine.snapshot())
    expect(restored.snapshot()).toEqual(engine.snapshot())
    expect(restored.receiptFor('npm test')).toEqual(engine.receiptFor('npm test'))
  })

  it('rebuild from events equals the live fold (resume consistency)', () => {
    const events: EngineEvent[] = [
      READ_A,
      READ_B,
      READ_A_AGAIN,
      WRITE,
      TEST_FAIL,
      READ_A_CHANGED,
      TEST_PASS,
    ]
    const live = new ProgressFactEngine({ fingerprintWindow: 8, verifyPatterns: [...DEFAULT_VERIFY_PATTERNS] })
    for (const eventItem of events) live.applyEvent(eventItem)
    const replayed = ProgressFactEngine.rebuild(events, { fingerprintWindow: 8, verifyPatterns: [...DEFAULT_VERIFY_PATTERNS] })
    expect(replayed.snapshot()).toEqual(live.snapshot())
  })
})