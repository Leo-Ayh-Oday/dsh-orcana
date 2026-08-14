/**
 * Adapter unit tests: DSH→core event translation (live and replay), the
 * exit-marker contract, mutation flags, and the live-vs-replay consistency
 * contract (translating a session log must rebuild the same engine state as
 * the live path).
 */
import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ProgressFactEngine } from '@orcana/governor-core'
import { toEngineEvent, translateSessionEvents } from '../src/index.ts'
import type { ReplayEvent } from '../src/index.ts'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function call(name: string, args: unknown, callId = 'c1') {
  return { callId, name, arguments: args }
}

describe('toEngineEvent', () => {
  it('extracts the normalized bash command and exit code from the marker contract', () => {
    const event = toEngineEvent(
      call('bash', { command: 'npm test --run' }),
      { content: [textBlock('output\n[exit code: 1]')], isError: false },
    )
    expect(event.command).toBe('npm test --run')
    expect(event.exitCode).toBe(1)
    expect(event.interrupted).toBe(false)
    expect(event.mutation).toBe(false)
  })

  it('clean exit 0 has no marker and no error', () => {
    const event = toEngineEvent(
      call('bash', { command: 'npm test' }),
      { content: [textBlock('ok')], isError: false },
    )
    expect(event.exitCode).toBeUndefined()
    expect(event.interrupted).toBe(false)
  })

  it('timeout and signal results are interrupted, not exit-coded', () => {
    const timedOut = toEngineEvent(
      call('bash', { command: 'npm test' }),
      { content: [textBlock('slow\n[timed out after 100ms]\n[exit code: 143]')], isError: false },
    )
    expect(timedOut.interrupted).toBe(true)
    const killed = toEngineEvent(
      call('bash', { command: 'npm test' }),
      { content: [textBlock('gone\n[killed by signal: SIGKILL]')], isError: false },
    )
    expect(killed.interrupted).toBe(true)
  })

  it('background acknowledgements carry no verification identity', () => {
    const event = toEngineEvent(
      call('bash', { command: 'npm test', run_in_background: true }),
      { content: [textBlock('started job 1')], isError: false },
    )
    expect(event.command).toBeUndefined()
  })

  it('mutation tools flag success only', () => {
    expect(toEngineEvent(call('write', { path: 'a', content: 'x' }), { content: [], isError: false }).mutation).toBe(true)
    expect(toEngineEvent(call('edit', { path: 'a' }), { content: [], isError: false }).mutation).toBe(true)
    expect(toEngineEvent(call('str_replace_editor', { path: 'a' }), { content: [], isError: false }).mutation).toBe(true)
    expect(toEngineEvent(call('write', { path: 'a' }), { content: [], isError: true }).mutation).toBe(false)
    expect(toEngineEvent(call('read', { path: 'a' }), { content: [], isError: false }).mutation).toBe(false)
  })

  it('canonicalizes argument order-insensitively', () => {
    const a = toEngineEvent(call('read', { path: 'a', offset: 1 }), { content: [textBlock('x')], isError: false })
    const b = toEngineEvent(call('read', { offset: 1, path: 'a' }), { content: [textBlock('x')], isError: false })
    expect(a.canonicalArgs).toBe(b.canonicalArgs)
  })
})

describe('translateSessionEvents (replay)', () => {
  function replayEvent(tool: string, args: unknown, content: string, isError: boolean, callId: string): ReplayEvent[] {
    return [
      { type: 'tool/call', data: { callId, name: tool, arguments: JSON.stringify(args) } },
      { type: 'tool/result', data: { message: { content: [{ callId, content: [textBlock(content)], isError }] } } },
    ]
  }

  it('rebuilds engine state identical to the live path (resume consistency)', () => {
    // The same logical run expressed twice: live executions and a session log.
    const liveCalls = [
      { tool: 'read', args: { path: 'a' }, out: 'r1', isError: false },
      { tool: 'read', args: { path: 'b' }, out: 'r2', isError: false },
      { tool: 'read', args: { path: 'a' }, out: 'r1', isError: false },
      { tool: 'write', args: { path: 'a', content: 'x' }, out: '', isError: false },
      { tool: 'bash', args: { command: 'npm test' }, out: 'fail\n[exit code: 1]', isError: false },
      { tool: 'read', args: { path: 'a' }, out: 'r3', isError: false },
      { tool: 'bash', args: { command: 'npm test' }, out: 'ok', isError: false },
    ]

    const live = new ProgressFactEngine()
    liveCalls.forEach((c, index) => {
      live.applyEvent(toEngineEvent(
        call(c.tool, c.args, 'c' + index),
        { content: [textBlock(c.out)], isError: c.isError },
      ))
    })

    const events: ReplayEvent[] = []
    liveCalls.forEach((c, index) => {
      events.push(...replayEvent(c.tool, c.args, c.out, c.isError, 'c' + index))
    })
    const replayed = ProgressFactEngine.rebuild(translateSessionEvents(events))

    expect(replayed.snapshot()).toEqual(live.snapshot())
    expect(replayed.receiptFor('npm test')?.status).toBe('pass')
    expect(replayed.currentGeneration()).toBe(1)
  })

  it('pairs results with their calls and skips orphan results', () => {
    const events: ReplayEvent[] = [
      ...replayEvent('bash', { command: 'npm test' }, 'fail\n[exit code: 1]', false, 'c1'),
      { type: 'tool/result', data: { message: { content: [{ callId: 'orphan', content: [textBlock('x')], isError: false }] } } },
    ]
    const translated = translateSessionEvents(events)
    expect(translated).toHaveLength(1)
    expect(translated[0]?.callId).toBe('c1')
  })

  it('recovers malformed argument JSON as the raw string (matching the agent loop)', () => {
    const events: ReplayEvent[] = [
      { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: 'not-json' } },
      { type: 'tool/result', data: { message: { content: [{ callId: 'c1', content: [textBlock('x')], isError: false }] } } },
    ]
    const translated = translateSessionEvents(events)
    expect(translated[0]?.canonicalArgs).toBe(JSON.stringify('not-json'))
  })
})
