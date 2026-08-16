/**
 * Analyze unit tests: run-record loading, paired folding, and the stable
 * report text.
 */
import { describe, expect, it } from 'vitest'
import { foldPairs, renderAnalysis, tokenSum, wallMs } from '../analyze.mjs'

function record(task, arm, outcome, calls, startedAt, finishedAt, inputTokens = 100) {
  return {
    task_id: task,
    arm,
    verdict: { outcome, reason: outcome },
    started_at: startedAt,
    finished_at: finishedAt,
    metrics: { llm_calls: calls, input_tokens: inputTokens, output_tokens: 50, cache_read_tokens: 10 },
  }
}

describe('foldPairs', () => {
  it('pairs control/treatment per task with deltas', () => {
    const rows = foldPairs([
      record('demo', 'control', 'completed', 12, '2026-08-16T00:00:00Z', '2026-08-16T00:01:30Z'),
      record('demo', 'treatment', 'completed', 9, '2026-08-16T00:01:40Z', '2026-08-16T00:02:50Z', 70),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.task).toBe('demo')
    const pair = rows[0]?.reps[0]
    expect(pair?.control?.metrics.llm_calls).toBe(12)
    expect(pair?.treatment?.metrics.llm_calls).toBe(9)
    expect(pair?.deltas).toEqual({ calls: -3, tokens: -30, wall_ms: -20000 })
  })

  it('missing arms leave deltas undefined and label the row', () => {
    const rows = foldPairs([record('solo', 'control', 'completed', 5, 'a', 'b')])
    expect(rows[0]?.reps[0]?.treatment).toBeUndefined()
    expect(rows[0]?.reps[0]?.deltas).toBeUndefined()
  })

  it('orders tasks deterministically', () => {
    const rows = foldPairs([
      record('zeta', 'control', 'x', 1, 'a', 'b'),
      record('alpha', 'control', 'x', 1, 'a', 'b'),
    ])
    expect(rows.map(row => row.task)).toEqual(['alpha', 'zeta'])
  })
})

describe('tokenSum / wallMs', () => {
  it('sums tokens and wall time from records', () => {
    const run = record('t', 'control', 'x', 1, '2026-08-16T00:00:00Z', '2026-08-16T00:00:05Z')
    expect(tokenSum(run)).toBe(150)
    expect(wallMs(run)).toBe(5000)
  })
})

describe('renderAnalysis', () => {
  it('renders the stable paired format', () => {
    const rows = foldPairs([
      record('demo', 'control', 'completed', 12, '2026-08-16T00:00:00Z', '2026-08-16T00:01:30Z'),
      record('demo', 'treatment', 'completed', 9, '2026-08-16T00:01:40Z', '2026-08-16T00:02:50Z', 70),
    ])
    const text = renderAnalysis(rows)
    expect(text).toContain('  demo (rep 0):')
    expect(text).toContain('control:   completed:completed calls=12 wall=90s')
    expect(text).toContain('treatment: completed:completed calls=9 wall=70s')
    expect(text).toContain('delta: calls=-3 tokens=-30 wall_ms=-20000')
  })
})
