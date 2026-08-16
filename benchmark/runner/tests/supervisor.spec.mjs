/**
 * Supervisor unit tests: deterministic pairing, authoritative verdicts, and
 * the session-log call counter.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ARMS,
  OUTCOMES,
  armOrder,
  countAssistantMessages,
  mulberry32,
  outcomeOf,
  planRuns,
} from '../supervisor.mjs'

describe('armOrder (paired, deterministic)', () => {
  it('returns both arms exactly once per task', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const order = armOrder(0, seed)
      expect(order).toHaveLength(2)
      expect([...order].sort()).toEqual([ARMS.CONTROL, ARMS.TREATMENT])
    }
  })

  it('is deterministic under the same seed', () => {
    expect(armOrder(3, 42)).toEqual(armOrder(3, 42))
    expect(armOrder(4, 42)).not.toEqual(armOrder(4, 43))
  })

  it('different tasks under one seed still mix (not all same order)', () => {
    const orders = new Set()
    for (let task = 0; task < 20; task += 1) orders.add(armOrder(task, 7).join('|'))
    expect(orders.size).toBeGreaterThan(1)
  })
})

describe('planRuns', () => {
  const manifests = [{ task_id: 'a' }, { task_id: 'b' }]

  it('pairs each task arms consecutively', () => {
    const plan = planRuns(manifests, { seed: 1 })
    expect(plan.map(run => run.task)).toEqual(['a', 'a', 'b', 'b'])
    expect(plan[0]?.arm).not.toBe(plan[1]?.arm)
  })

  it('reps multiply the pairs, keeping adjacency', () => {
    const plan = planRuns(manifests, { seed: 1, reps: 2 })
    expect(plan).toHaveLength(8)
    expect(plan[2]?.task).toBe('a')
    expect(plan[3]?.task).toBe('a')
  })

  it('is deterministic under the same seed', () => {
    expect(planRuns(manifests, { seed: 5 })).toEqual(planRuns(manifests, { seed: 5 }))
  })
})

describe('outcomeOf (authoritative verdicts)', () => {
  it('wall exhaustion wins over any exit code (never exit-0 success)', () => {
    expect(outcomeOf({ budgetHit: 'wall', exitCode: 0, signal: undefined }))
      .toEqual({ outcome: OUTCOMES.INCOMPLETE_TIMEOUT, reason: 'wall_time_budget_exhausted', exitCode: 0, signal: undefined })
  })

  it('call exhaustion is incomplete, not success', () => {
    expect(outcomeOf({ budgetHit: 'calls', exitCode: 0, signal: 'SIGTERM' }).outcome)
      .toBe(OUTCOMES.INCOMPLETE_CALLS)
  })

  it('a natural exit is completed — success is the judges call', () => {
    expect(outcomeOf({ budgetHit: undefined, exitCode: 0, signal: undefined }))
      .toEqual({ outcome: OUTCOMES.COMPLETED, reason: 'exited', exitCode: 0, signal: undefined })
  })

  it('a killed run without budget is infra (spawn-level) failure', () => {
    expect(outcomeOf({ budgetHit: undefined, exitCode: null, signal: 'SIGKILL' }).outcome)
      .toBe(OUTCOMES.INFRA_FAILURE)
  })
})

describe('mulberry32', () => {
  it('produces stable values in [0, 1)', () => {
    const rand = mulberry32(1)
    const first = rand()
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(1)
    expect(mulberry32(1)()).toBe(first)
  })
})

describe('countAssistantMessages', () => {
  it('counts assistant/message events across session logs', () => {
    const home = join(tmpdir(), `bench-calls-${Date.now()}`)
    mkdirSync(join(home, 'sessions', '--ns--', 'session-1'), { recursive: true })
    mkdirSync(join(home, 'sessions', '--ns--', 'session-2'), { recursive: true })
    const lines = [
      '{"type":"user/message","data":{}}',
      '{"type":"assistant/message","data":{"usage":{"inputTokens":1}}}',
      '{"type":"tool/call","data":{}}',
    ].join('\n')
    for (const session of ['session-1', 'session-2']) {
      const raw = join(home, 'sessions', '--ns--', session, 'session.jsonl')
      writeFileSync(raw, lines)
      execFileSync('zstd', ['-f', '-o', `${raw}.zstd`, raw], { stdio: 'ignore' })
    }
    expect(countAssistantMessages(home)).toBe(2)
  })

  it('is 0 without a sessions directory', () => {
    expect(countAssistantMessages(join(tmpdir(), 'does-not-exist-bench'))).toBe(0)
  })
})
