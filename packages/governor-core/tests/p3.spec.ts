/**
 * P3 unit tests: the verification-state snapshot rendering (fixed
 * model-visible format, snapshot-covered).
 */
import { describe, expect, it } from 'vitest'
import { ProgressFactEngine, renderVerificationState } from '../src/index.ts'
import type { EngineEvent, VerificationReceipt } from '../src/index.ts'

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

const TEST = (command: string, hash: string, exitCode: number | undefined, callId = 'c' + hash): EngineEvent => event({
  tool: 'bash',
  canonicalArgs: JSON.stringify({ command }),
  command,
  resultHash: hash,
  exitCode,
  callId,
})

function receipt(command: string, status: VerificationReceipt['status'], generation: number): VerificationReceipt {
  return { command, resultHash: 'h', generation, status, callId: 'c' }
}

describe('renderVerificationState', () => {
  it('is undefined without any receipt', () => {
    expect(renderVerificationState([], 0, true)).toBeUndefined()
  })

  it('renders a fixed-format single receipt', () => {
    expect(renderVerificationState([receipt('npm test', 'pass', 3)], 3, true))
      .toBe('Verification state:\n- npm test: PASS @gen3')
  })

  it('sorts commands ascending regardless of insertion order', () => {
    expect(renderVerificationState(
      [receipt('npm run build', 'pass', 1), receipt('npm test', 'fail', 1)],
      1,
      true,
    )).toBe('Verification state:\n- npm run build: PASS @gen1\n- npm test: FAIL @gen1')
  })

  it('flags STALE receipts when freshness is on', () => {
    expect(renderVerificationState([receipt('npm test', 'pass', 2)], 5, true))
      .toBe('Verification state:\n- npm test: PASS @gen2 STALE')
  })

  it('does not flag staleness when freshness is off', () => {
    expect(renderVerificationState([receipt('npm test', 'pass', 2)], 5, false))
      .toBe('Verification state:\n- npm test: PASS @gen2')
  })

  it('renders unknown statuses', () => {
    expect(renderVerificationState([receipt('npm test', 'unknown', 1)], 1, true))
      .toBe('Verification state:\n- npm test: UNKNOWN @gen1')
  })

  it('matches the engine-driven end-to-end snapshot', () => {
    const engine = new ProgressFactEngine()
    engine.applyEvent(TEST('npm test', 't1', 1))
    engine.applyEvent(event({ tool: 'write', mutation: true, resultHash: 'w' }))
    const snapshot = engine.snapshot()
    expect(renderVerificationState(snapshot.receipts, engine.currentGeneration(), true))
      .toBe('Verification state:\n- npm test: FAIL @gen0 STALE')
  })
})