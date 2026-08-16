/**
 * Session-log aggregation (P6): fold a run's session JSONL (zstd) into the
 * metric row. Pure, offline, tested — reports never mix metrics with
 * verdicts (PLAN 5.8).
 *
 * Metrics (PLAN 5.8 core subset, all from the session log):
 * - llm_calls: `assistant/message` events (one per model request)
 * - input/output/cache tokens: `assistant/message` usage, accumulated
 * - tool_calls: `tool/call` events
 * - wall_ms: first→last event timestamps (supervisor records the run wall)
 * @module orcana-benchmark/aggregate
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'

/** Parse one JSONL line into an event, or undefined for junk lines. */
export function parseSessionLine(line) {
  if (typeof line !== 'string') return undefined
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** Empty metric row — everything 0, no events seen. */
export function emptyRow() {
  return {
    llm_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    tool_calls: 0,
    first_event_ms: undefined,
    last_event_ms: undefined,
  }
}

/**
 * Fold one parsed session event into the metric row.
 * @param row - the accumulating row (mutated and returned).
 * @param event - one parsed log event.
 * @returns the same row.
 */
export function foldEvent(row, event) {
  if (event === undefined || event === null || typeof event !== 'object') return row
  const data = event.data ?? {}
  const time = typeof event.time === 'number' ? event.time : undefined
  if (time !== undefined) {
    if (row.first_event_ms === undefined || time < row.first_event_ms) row.first_event_ms = time
    if (row.last_event_ms === undefined || time > row.last_event_ms) row.last_event_ms = time
  }
  if (event.type === 'assistant/message') {
    row.llm_calls += 1
    const usage = data.usage
    if (usage !== undefined && typeof usage === 'object') {
      row.input_tokens += usage.inputTokens ?? 0
      row.output_tokens += usage.outputTokens ?? 0
      row.cache_read_tokens += usage.cacheReadTokens ?? 0
      row.cache_write_tokens += usage.cacheWriteTokens ?? 0
    }
  }
  if (event.type === 'tool/call') {
    row.tool_calls += 1
  }
  return row
}

/**
 * Aggregate a full session log text (already decompressed).
 * @param text - decompressed JSONL content.
 * @returns the metric row.
 */
export function aggregateText(text) {
  const row = emptyRow()
  for (const line of text.split('\n')) {
    foldEvent(row, parseSessionLine(line))
  }
  return row
}

/**
 * Aggregate a run's session log file (zstd). When multiple session files
 * exist (unexpected), all are folded — the budget poll reads the same
 * source, so counts agree with the supervisor's.
 * @param sessionDir - the `$DSH_HOME/sessions` directory.
 * @returns the metric row.
 */
export function aggregateSessions(sessionDir) {
  const row = emptyRow()
  if (!existsSync(sessionDir)) return row
  for (const ns of readdirSync(sessionDir)) {
    const nsDir = `${sessionDir}/${ns}`
    if (!existsSync(nsDir)) continue
    for (const session of readdirSync(nsDir)) {
      const log = `${nsDir}/${session}/session.jsonl.zstd`
      if (!existsSync(log)) continue
      const text = execFileSync('zstd', ['-dc', log], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      foldTextInto(row, text)
    }
  }
  return row
}

function foldTextInto(row, text) {
  for (const line of text.split('\n')) {
    foldEvent(row, parseSessionLine(line))
  }
}

/**
 * Render the compact metrics line for one run.
 * @param row - the metric row.
 * @param extra - per-run facts ({ task_id, arm, verdict }).
 * @returns the stable one-line summary.
 */
export function renderMetricsRow(row, extra = {}) {
  const parts = [
    `calls=${row.llm_calls}`,
    `in=${row.input_tokens}`,
    `out=${row.output_tokens}`,
    `cache_r=${row.cache_read_tokens}`,
    `cache_w=${row.cache_write_tokens}`,
    `tools=${row.tool_calls}`,
    `wall_ms=${row.last_event_ms !== undefined && row.first_event_ms !== undefined ? row.last_event_ms - row.first_event_ms : '-'}`,
  ]
  const tag = extra.task_id !== undefined ? `${extra.task_id}[${extra.arm}] ${extra.verdict}` : 'summary'
  return `${tag}: ${parts.join(' ')}`
}
