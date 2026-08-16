/**
 * Aggregate unit tests: session-log folding into the metric row.
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateText,
  emptyRow,
  foldEvent,
  parseSessionLine,
  renderMetricsRow,
} from '../aggregate.mjs'

describe('parseSessionLine', () => {
  it('parses valid JSON lines and skips junk', () => {
    expect(parseSessionLine('{"a":1}')).toEqual({ a: 1 })
    expect(parseSessionLine('  {"b":2}  ')).toEqual({ b: 2 })
    expect(parseSessionLine('not-json')).toBeUndefined()
    expect(parseSessionLine('')).toBeUndefined()
    expect(parseSessionLine(undefined)).toBeUndefined()
  })
})

describe('foldEvent', () => {
  it('counts assistant messages and accumulates usage', () => {
    const row = emptyRow()
    foldEvent(row, {
      type: 'assistant/message',
      time: 1000,
      data: { usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2 } },
    })
    expect(row.llm_calls).toBe(1)
    expect(row.input_tokens).toBe(10)
    expect(row.output_tokens).toBe(3)
    expect(row.cache_read_tokens).toBe(5)
    expect(row.cache_write_tokens).toBe(2)
  })

  it('counts tool calls and tracks event time span', () => {
    const row = emptyRow()
    foldEvent(row, { type: 'tool/call', time: 500, data: {} })
    foldEvent(row, { type: 'assistant/message', time: 900, data: {} })
    expect(row.tool_calls).toBe(1)
    expect(row.first_event_ms).toBe(500)
    expect(row.last_event_ms).toBe(900)
  })

  it('ignores unknown events; usage-less assistant messages still count as calls', () => {
    const row = emptyRow()
    foldEvent(row, { type: 'weird', data: {} })
    foldEvent(row, { type: 'assistant/message', data: {} })
    expect(row.llm_calls).toBe(1)
    expect(row.input_tokens).toBe(0)
    expect(row.output_tokens).toBe(0)
    expect(row.tool_calls).toBe(0)
  })

  it('tolerates malformed events', () => {
    const row = emptyRow()
    foldEvent(row, undefined)
    foldEvent(row, null)
    foldEvent(row, 'nope')
    expect(row).toEqual(emptyRow())
  })
})

describe('aggregateText', () => {
  it('folds a full log', () => {
    const text = [
      '{"type":"user/message","time":1,"data":{}}',
      '{"type":"assistant/message","time":2,"data":{"usage":{"inputTokens":5,"outputTokens":2}}}',
      '{"type":"tool/call","time":3,"data":{}}',
      '{"type":"assistant/message","time":4,"data":{"usage":{"inputTokens":7}}}',
    ].join('\n')
    const row = aggregateText(text)
    expect(row.llm_calls).toBe(2)
    expect(row.input_tokens).toBe(12)
    expect(row.output_tokens).toBe(2)
    expect(row.tool_calls).toBe(1)
    expect(row.first_event_ms).toBe(1)
    expect(row.last_event_ms).toBe(4)
  })
})

describe('renderMetricsRow', () => {
  it('renders the stable one-line summary', () => {
    const row = aggregateText([
      '{"type":"assistant/message","time":0,"data":{"usage":{"inputTokens":10,"outputTokens":4,"cacheReadTokens":3,"cacheWriteTokens":1}}}',
      '{"type":"assistant/message","time":1000,"data":{"usage":{"inputTokens":5}}}',
      '{"type":"tool/call","time":500,"data":{}}',
    ].join('\n'))
    const line = renderMetricsRow(row, { task_id: 'demo-1', arm: 'control', verdict: 'completed' })
    expect(line).toBe('demo-1[control] completed: calls=2 in=15 out=4 cache_r=3 cache_w=1 tools=1 wall_ms=1000')
  })
})
