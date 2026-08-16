/**
 * R2 (M3): behavior-level tests of apply() — the actual listeners, driven
 * through a minimal Cordis context with mocked services. Locks the wiring
 * the pure-function tests cannot: post-execute folding into the engine,
 * turn-stopping steering, pre-step budget reset, and the P5 restrict hook.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Config, apply } from '../src/index.ts'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

function fakeContext(): { ctx: Context; spies: { steer: ReturnType<typeof vi.fn>; restrict: ReturnType<typeof vi.fn> } } {
  const spies = {
    steer: vi.fn(),
    restrict: vi.fn(() => () => undefined),
  }
  const ctx = new Context()
  ctx.provide('tools', {
    get: () => ({ name: 'mock-tool' }),
    restrict: spies.restrict,
  })
  return { ctx, spies }
}

function fakeAgent(spies?: { steer: ReturnType<typeof vi.fn> }, ctx?: Context): { agent: Agent } {
  return {
    agent: {
      session: { events: [] },
      ctx: ctx ?? new Context(),
      steer: spies?.steer,
    } as unknown as Agent,
  }
}

function exec(agent: Agent, name: string, args: Record<string, unknown>, callId = 'c1'): ToolExecution {
  return { agent, callId, name, arguments: args } as unknown as ToolExecution
}

function postExecute(ctx: Context, execution: ToolExecution, isError = false) {
  return ctx.waterfall('tools/post-execute' as never, execution, {
    isError,
    content: [{ type: 'text', text: 'ok' }],
  } as never, (() => Promise.resolve({ type: 'post-tool', includeInContexts: false })) as never) as unknown as Promise<PostToolDecision | undefined>
}

function turnStopping(ctx: Context, agent: Agent) {
  return ctx.emit('agent/turn-stopping' as never, { agent, turn: {}, signal: new AbortController().signal } as never) as unknown as Promise<void>
}

describe('apply() wiring (behavior-level)', () => {
  it('folds tool observations and steers on the zero-progress ladder', async () => {
    const { ctx, spies } = fakeContext()
    apply(ctx, Config())
    const { agent } = fakeAgent(spies, ctx)

    // Round 1: a first read (progress) — no steer.
    await postExecute(ctx, exec(agent, 'read', { path: 'a' }), false)
    await turnStopping(ctx, agent)
    expect(spies.steer).not.toHaveBeenCalled()

    // Round 2: the same read twice → repeated → zero-progress at chain 1
    // (below the [2,3,4] thresholds) — still no steer.
    await postExecute(ctx, exec(agent, 'read', { path: 'a' }, 'c2'), false)
    await postExecute(ctx, exec(agent, 'read', { path: 'a' }, 'c3'), false)
    await turnStopping(ctx, agent)
    expect(spies.steer).not.toHaveBeenCalled()

    // Round 3: repeats again → chain 2 → GENTLE steer.
    await postExecute(ctx, exec(agent, 'read', { path: 'a' }, 'c4'), false)
    await postExecute(ctx, exec(agent, 'read', { path: 'a' }, 'c5'), false)
    await turnStopping(ctx, agent)
    expect(spies.steer).toHaveBeenCalledTimes(1)
    const [message] = spies.steer.mock.calls[0] as [{ content: [{ text: string }] }]
    expect(message.content[0]?.text).toContain('2 consecutive rounds without progress')
  })

  it('a user-source pre-step resets the forced budget (chains start over)', async () => {
    const { ctx, spies } = fakeContext()
    apply(ctx, Config())
    const { agent } = fakeAgent(spies, ctx)

    for (let round = 0; round < 3; round += 1) {
      await postExecute(ctx, exec(agent, 'read', { path: 'a' }, `c${round}a`), false)
      await postExecute(ctx, exec(agent, 'read', { path: 'a' }, `c${round}b`), false)
      await turnStopping(ctx, agent)
    }
    expect(spies.steer).toHaveBeenCalledTimes(1) // chain 2 at round 2

    // A user message interjection resets chains: the next repeated round
    // restarts from chain 1 — no steer, despite the prior budget usage.
    await ctx.emit('agent/pre-step' as never, {
      agent,
      messages: [{ source: { kind: 'user' } }],
    } as never)
    await postExecute(ctx, exec(agent, 'read', { path: 'a' }, 'd1'), false)
    await postExecute(ctx, exec(agent, 'read', { path: 'a' }, 'd2'), false)
    await turnStopping(ctx, agent)
    expect(spies.steer).toHaveBeenCalledTimes(1)
  })

  it('a plugin-source pre-step does NOT reset the budget', async () => {
    const { ctx, spies } = fakeContext()
    apply(ctx, Config())
    const { agent } = fakeAgent(spies, ctx)

    for (let round = 0; round < 3; round += 1) {
      await postExecute(ctx, exec(agent, 'read', { path: 'a' }, `c${round}a`), false)
      await postExecute(ctx, exec(agent, 'read', { path: 'a' }, `c${round}b`), false)
      await turnStopping(ctx, agent)
    }
    expect(spies.steer).toHaveBeenCalledTimes(1)

    await ctx.emit('agent/pre-step' as never, {
      agent,
      messages: [{ source: { kind: 'plugin' } }],
    } as never)
    await postExecute(ctx, exec(agent, 'read', { path: 'a' }, 'd1'), false)
    await postExecute(ctx, exec(agent, 'read', { path: 'a' }, 'd2'), false)
    await turnStopping(ctx, agent)
    expect(spies.steer).toHaveBeenCalledTimes(2) // budget intact → steers again
  })

  it('completion guard steers when the agent claims completion without evidence', async () => {
    const { ctx, spies } = fakeContext()
    apply(ctx, Config())
    const { agent } = fakeAgent(spies, ctx)
    // Turn 1: a mutation (write) then a failing verification — engine has a
    // fail receipt at gen 1.
    await postExecute(ctx, exec(agent, 'write', { path: 'a', content: 'x' }), false)
    await postExecute(ctx, exec(agent, 'bash', { command: 'npm test' }, 't1'), true)
    await turnStopping(ctx, agent)

    // The agent's final text claims completion without a fresh pass receipt —
    // the guard steers even though the ladder has nothing to say.
    ;(agent.session as { events: unknown[] }).events = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'All tests pass. Task complete.' }] } } },
    ]
    await turnStopping(ctx, agent)
    const calls = spies.steer.mock.calls.map(call => (call[0] as { content: [{ text: string }] }).content[0]?.text)
    expect(calls.some(text => text?.includes('Completion guard'))).toBe(true)
  })

  it('capability router restricts tools at agent/created when disclosure is on', async () => {
    const { ctx, spies } = fakeContext()
    apply(ctx, Config({ tools: { disclosure: 'task-profile', defaultProfile: 'coding' } }))
    const { agent } = fakeAgent(spies, ctx)
    await ctx.emit('agent/created' as never, { agent } as never)
    expect(spies.restrict).toHaveBeenCalled()
    const [restriction] = spies.restrict.mock.calls[0] as [{ allow: string[] }]
    expect(restriction.allow).toContain('read')
    expect(restriction.allow).toContain('bash')
  })

  it('capability router is inert when disclosure is off', async () => {
    const { ctx, spies } = fakeContext()
    apply(ctx, Config({ tools: { disclosure: 'off' } }))
    const { agent } = fakeAgent(spies, ctx)
    await ctx.emit('agent/created' as never, { agent } as never)
    expect(spies.restrict).not.toHaveBeenCalled()
  })
})
