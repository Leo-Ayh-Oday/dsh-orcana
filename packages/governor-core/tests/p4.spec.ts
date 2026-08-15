/**
 * P4 unit tests: the completion claim guard — the three objective rules
 * (PLAN 3.3), claim-token extraction, and the stable steer rendering.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLAIM_PATTERNS,
  claimedTokens,
  completionViolations,
  renderCompletionSteer,
} from '../src/index.ts'
import type { CompletionGuardOptions, CompletionGuardState, VerificationReceipt } from '../src/index.ts'

const OPTIONS: CompletionGuardOptions = {
  claimCheck: true,
  claimPatterns: DEFAULT_CLAIM_PATTERNS,
  verifyPatterns: ['test', 'typecheck', 'build', 'check', 'lint'],
}

function receipt(command: string, status: VerificationReceipt['status'], generation: number): VerificationReceipt {
  return { command, resultHash: 'h', generation, status, callId: 'c' }
}

function state(generation: number, receipts: readonly VerificationReceipt[] = []): CompletionGuardState {
  return { generation, receipts }
}

describe('completionViolations — rule 1 (unverified mutation)', () => {
  it('flags a mutated workspace with no pass receipt at all', () => {
    expect(completionViolations(state(3, []), undefined, OPTIONS))
      .toEqual([{ rule: 1, kind: 'unverified-mutation' }])
  })

  it('flags a pass receipt made stale by a later mutation', () => {
    expect(completionViolations(state(4, [receipt('npm test', 'pass', 3)]), undefined, OPTIONS))
      .toEqual([{ rule: 1, kind: 'unverified-mutation' }])
  })

  it('passes a pristine workspace without verification', () => {
    expect(completionViolations(state(0), undefined, OPTIONS)).toEqual([])
  })

  it('passes when any command has a current-generation pass receipt', () => {
    expect(completionViolations(state(2, [receipt('npm test', 'pass', 2)]), undefined, OPTIONS)).toEqual([])
  })
})

describe('completionViolations — rule 2 (failing verification)', () => {
  it('flags the latest receipt of each failing command', () => {
    expect(completionViolations(state(2, [
      receipt('npm run build', 'pass', 2),
      receipt('npm test', 'fail', 2),
    ]), undefined, OPTIONS)).toEqual([{ rule: 2, kind: 'failing-verification', command: 'npm test' }])
  })

  it('a later pass receipt overrides an earlier fail of the same command (map keeps latest)', () => {
    expect(completionViolations(state(2, [receipt('npm test', 'pass', 2)]), undefined, OPTIONS)).toEqual([])
  })

  it('cross-command results do not offset each other', () => {
    expect(completionViolations(state(1, [
      receipt('npm test', 'fail', 1),
      receipt('tsc --noEmit', 'pass', 1),
    ]), undefined, OPTIONS)).toEqual([{ rule: 2, kind: 'failing-verification', command: 'npm test' }])
  })

  it('lists failing commands in ascending order', () => {
    expect(completionViolations(state(1, [
      receipt('npm test', 'fail', 1),
      receipt('npm run build', 'fail', 1),
      receipt('npm run lint', 'pass', 1),
    ]), undefined, OPTIONS)).toEqual([
      { rule: 2, kind: 'failing-verification', command: 'npm run build' },
      { rule: 2, kind: 'failing-verification', command: 'npm test' },
    ])
  })

  it('unknown statuses do not trigger rule 2', () => {
    expect(completionViolations(state(1, [
      receipt('npm test', 'unknown', 1),
      receipt('npm run lint', 'pass', 1),
    ]), undefined, OPTIONS)).toEqual([])
  })
})

describe('completionViolations — rule 3 (unsupported claim, opt-in)', () => {
  it('flags a "tests pass" claim without a fresh pass receipt', () => {
    expect(completionViolations(
      state(1, [receipt('npm run lint', 'pass', 1)]),
      'All tests pass. Task complete.',
      OPTIONS,
    )).toEqual([{ rule: 3, kind: 'unsupported-claim', token: 'test' }])
  })

  it('passes the claim when the named command has a current-generation pass receipt', () => {
    expect(completionViolations(
      state(2, [receipt('npm test', 'pass', 2)]),
      'All tests pass now.',
      OPTIONS,
    )).toEqual([])
  })

  it('a stale pass receipt does not support the claim', () => {
    expect(completionViolations(
      state(2, [
        receipt('npm test', 'pass', 1),
        receipt('npm run lint', 'pass', 2),
      ]),
      'Tests pass.',
      OPTIONS,
    )).toEqual([{ rule: 3, kind: 'unsupported-claim', token: 'test' }])
  })

  it('rule 3 is inert when claimCheck is off', () => {
    expect(completionViolations(
      state(1, [
        receipt('npm test', 'fail', 1),
        receipt('npm run lint', 'pass', 1),
      ]),
      'All tests pass.',
      { ...OPTIONS, claimCheck: false },
    )).toEqual([{ rule: 2, kind: 'failing-verification', command: 'npm test' }])
  })

  it('rule 3 is inert without claim text', () => {
    expect(completionViolations(state(0), undefined, OPTIONS)).toEqual([])
  })

  it('an unsupported claim does not override rule 1', () => {
    expect(completionViolations(state(3, []), 'All tests pass.', OPTIONS)).toEqual([
      { rule: 1, kind: 'unverified-mutation' },
      { rule: 3, kind: 'unsupported-claim', token: 'test' },
    ])
  })
})

describe('claimedTokens', () => {
  it('extracts named verification tokens with inflections', () => {
    expect(claimedTokens('All tests passed, typecheck is green', OPTIONS.verifyPatterns))
      .toEqual(['test', 'typecheck'])
  })

  it('deduplicates and preserves configured order', () => {
    expect(claimedTokens('test test build test', OPTIONS.verifyPatterns))
      .toEqual(['test', 'build'])
  })

  it('extraction is loose prose matching (the claim patterns gate rule 3)', () => {
    // `grep -r test` prose extracts `test`; the guard never fires on it
    // because rule 3 additionally requires a completion-claim pattern hit.
    expect(claimedTokens('I ran grep -r test src', OPTIONS.verifyPatterns)).toEqual(['test'])
  })

  it('finds segment-scoped patterns', () => {
    expect(claimedTokens('build:all passed', ['build', 'build:all'])).toEqual(['build:all'])
  })
})

describe('renderCompletionSteer', () => {
  it('is undefined without violations', () => {
    expect(renderCompletionSteer([])).toBeUndefined()
  })

  it('renders a fixed-format single violation', () => {
    expect(renderCompletionSteer([{ rule: 1, kind: 'unverified-mutation' }]))
      .toBe('Completion guard:\n- the workspace changed but no verification passed on the current generation')
  })

  it('renders rule 2 and rule 3 lines stably', () => {
    expect(renderCompletionSteer([
      { rule: 2, kind: 'failing-verification', command: 'npm test' },
      { rule: 3, kind: 'unsupported-claim', token: 'test' },
    ])).toBe([
      'Completion guard:',
      '- verification "npm test" is failing',
      '- "test" was claimed to pass without fresh evidence',
    ].join('\n'))
  })
})
