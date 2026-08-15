/**
 * P4 adapter tests: the completion-guard wiring — Config defaults, the
 * last-assistant-text extraction from session logs, and the shared
 * forced-continuation budget between the zero-progress ladder and the
 * completion guard.
 */
import { describe, expect, it } from 'vitest'
import { Config, lastAssistantText } from '../src/index.ts'

describe('completion config defaults', () => {
  it('evidence-bound with a bounded continuation budget', () => {
    const config = Config()
    expect(config.completion.mode).toBe('evidence-bound')
    expect(config.completion.maxForcedContinuations).toBe(3)
  })

  it('rule 3 (claim check) is opt-in', () => {
    const config = Config()
    expect(config.completion.claimCheck).toBe(false)
    expect(config.completion.claimPatterns).toContain('(all\\s+)?tests?\\s+pass(es|ed)?\\b')
  })
})

describe('lastAssistantText', () => {
  function textBlock(text: string) {
    return { type: 'text' as const, text }
  }

  function sessionWith(events: Array<{ type: 'assistant/message'; content: unknown[] }>): { events: unknown[] } {
    return {
      events: events.map((event, index) => ({
        type: event.type,
        seq: index,
        data: { turn: 0, step: index, message: { content: event.content } },
      })),
    }
  }

  it('returns the most recent non-empty assistant text', () => {
    const session = sessionWith([
      { type: 'assistant/message', content: [textBlock('older')] },
      { type: 'assistant/message', content: [textBlock('All tests pass.')] },
    ])
    expect(lastAssistantText(session as never)).toBe('All tests pass.')
  })

  it('skips empty assistant texts when looking for the latest', () => {
    const session = sessionWith([
      { type: 'assistant/message', content: [textBlock('Tests pass.')] },
      { type: 'assistant/message', content: [] },
    ])
    expect(lastAssistantText(session as never)).toBe('Tests pass.')
  })

  it('is undefined without an assistant message or a session', () => {
    expect(lastAssistantText(undefined)).toBeUndefined()
    expect(lastAssistantText({ events: [] } as never)).toBeUndefined()
  })
})
