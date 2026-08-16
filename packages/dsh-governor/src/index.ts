/**
 * @leooday/dsh-governor — DSH adapter for the Orcana runtime pack.
 *
 * Function plugin mounting the framework-agnostic ProgressFactEngine on DSH
 * extension points: observes `tools/post-execute` through
 * {@link toEngineEvent}, resets on user interjection at `agent/pre-step`,
 * and intercepts `agent/turn-stopping` to settle each round, escalate the
 * zero-progress ladder (bounded by maxForcedContinuations), and run the
 * evidence-bound completion guard (three objective rules, PLAN 3.3). Both
 * steer paths share one forced-continuation budget per agent. Model-visible
 * output (steers/reminders) is plugin-source user messages riding
 * additionalContexts or agent.steer(), satisfying the model-visible ⟺
 * logged invariant. No fork, no agent-loop patch — pure Cordis extensions.
 *
 * The live observation path and the session-log replay path share one
 * translation ({@link toEngineEvent}) and one engine transition
 * (applyEvent), so resumed state cannot drift from live state by
 * construction.
 * @module @leooday/dsh-governor
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_CLAIM_PATTERNS,
  ProgressFactEngine,
  canonicalizeArgs,
  completionViolations,
  renderCompletionSteer,
  renderVerificationState,
  sha256,
  steerText,
} from '@leooday/governor-core'
import type { EngineEvent, TurnVerdict } from '@leooday/governor-core'

export const name = 'orcana-governor'

/** Governor steer decision: escalate the ladder or pass. */
export interface SteerDecision {
  readonly action: 'steer' | 'pass'
  /** The tiered reminder text, when steering. */
  readonly text: string | undefined
  readonly chainLength: number
}

/**
 * Pure steering policy: steer when the round was zero-progress, the chain
 * length hits a configured threshold, the mode is not 'observe', and the
 * forced-continuation budget is not exhausted. Extracted for tests; the
 * turn-stopping listener is a thin wrapper.
 * @param verdict - the settled round.
 * @param config - governor steering knobs.
 * @param forcedCount - governor-issued continuations so far this session.
 * @returns the decision.
 */
export function decideSteer(
  verdict: TurnVerdict,
  config: {
    enabled: boolean
    mode: 'observe' | 'warn-steer' | 'enforce'
    thresholds: readonly number[]
    maxForced: number
  },
  forcedCount: number,
): SteerDecision {
  if (!config.enabled || !verdict.zeroProgress || config.mode === 'observe') {
    return { action: 'pass', text: undefined, chainLength: verdict.chainLength }
  }
  if (!config.thresholds.includes(verdict.chainLength)) {
    return { action: 'pass', text: undefined, chainLength: verdict.chainLength }
  }
  if (forcedCount >= config.maxForced) {
    return { action: 'pass', text: undefined, chainLength: verdict.chainLength }
  }
  return {
    action: 'steer',
    text: steerText(verdict.chainLength, verdict.repeatedPattern, config.thresholds),
    chainLength: verdict.chainLength,
  }
}

/** Plugin config — every deployment-varying choice is a validated field. */
export interface Config {
  governor: {
    enabled: boolean
    mode: 'observe' | 'warn-steer' | 'enforce'
    zeroProgressThresholds: number[]
    /** Recent-observation window for repeated-call detection. */
    fingerprintWindow: number
    /** Tool-name wildcard patterns that get in-round repeat reminders (align with the coordinated repeat-tool-reminder exclude). */
    inlineRepeatTools: string[]
  }
  evidence: {
    enabled: boolean
    freshness: 'generation' | 'off'
    verifyCommandPatterns: string[]
  }
  completion: {
    mode: 'off' | 'evidence-bound'
    maxForcedContinuations: number
    /** Rule 3 (opt-in): check the assistant's final text for completion claims whose named verifications lack a fresh pass receipt. */
    claimCheck: boolean
    /** Regex-source completion-claim patterns (PLAN 3.3 rule 3 trigger). */
    claimPatterns: string[]
  }
  tools: {
    disclosure: 'off' | 'task-profile'
    defaultProfile: 'coding' | 'research' | 'minimal'
  }
}

export const Config: z<Config> = z.object({
  governor: z.object({
    enabled: z.boolean().default(true),
    mode: z.union(['observe', 'warn-steer', 'enforce'] as const).default('warn-steer'),
    zeroProgressThresholds: z.array(z.number()).default([2, 3, 4]),
    fingerprintWindow: z.number().step(1).min(1).default(8),
    inlineRepeatTools: z.array(z.string()).default(['read', 'bash', '*search*']),
  }),
  evidence: z.object({
    enabled: z.boolean().default(true),
    freshness: z.union(['generation', 'off'] as const).default('generation'),
    verifyCommandPatterns: z.array(z.string()).default(['test', 'typecheck', 'build', 'check', 'lint']),
  }),
  completion: z.object({
    mode: z.union(['off', 'evidence-bound'] as const).default('evidence-bound'),
    maxForcedContinuations: z.number().default(3),
    claimCheck: z.boolean().default(false),
    claimPatterns: z.array(z.string()).default([...DEFAULT_CLAIM_PATTERNS]),
  }),
  tools: z.object({
    disclosure: z.union(['off', 'task-profile'] as const).default('task-profile'),
    defaultProfile: z.union(['coding', 'research', 'minimal'] as const).default('coding'),
  }),
})

/**
 * Mutation-typed tools whose successful return advances the workspace
 * generation. Names are the DSH registry names (audit fix: the str-replace
 * editor registers as 'str_replace_editor', not 'str_replace'); the adapter
 * tests pin this set against DSH's registered names.
 */
const MUTATION_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'str_replace_editor'])

/** Shell tools whose `command` argument carries the verification identity. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash'])

/**
 * Normalized shell command from a call's parsed arguments: the `command`
 * string, trimmed. Undefined outside shell tools and for background
 * acknowledgements (a background ack has no terminal exit status and is not
 * a verification outcome).
 */
function shellCommand(tool: string, args: unknown): string | undefined {
  if (!SHELL_TOOLS.has(tool)) return undefined
  if (typeof args !== 'object' || args === null) return undefined
  const command = (args as { command?: unknown }).command
  if (typeof command !== 'string') return undefined
  const trimmed = command.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function shellText(content: readonly ContentBlock[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Recover the exit status from rendered shell-tool result text — the shared
 * marker contract owned by @deepseek-ai/dsh-shell (`[exit code: N]` /
 * `[killed by signal: X]` line-anchored at the end; `[timed out after …]`
 * line anywhere). Absent markers mean a clean exit 0. If DSH ever changes
 * the marker format, status degrades conservatively: unknown markers read as
 * clean exit 0, which only ever suppresses pass/fail-based steers.
 */
function shellExitStatus(text: string): { exitCode: number | undefined; interrupted: boolean } {
  const interrupted = /\n\[timed out after /.test(text)
    || /\n\[killed by signal: [^\]\n]+\]$/.test(text)
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  return { exitCode: exit?.[1] !== undefined ? Number(exit[1]) : undefined, interrupted }
}

/** Parse model tool arguments the way the agent loop does: JSON, else the raw string. */
function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return raw
  }
}

/**
 * One observed tool execution → engine event. This is the DSH→core
 * translation used by BOTH the live post-execute listener and the
 * session-log replay translator, so the two paths cannot drift.
 */
export function toEngineEvent(
  exec: { callId: string; name: string; arguments: unknown },
  result: { content: readonly ContentBlock[]; isError: boolean },
): EngineEvent {
  const tool = exec.name
  const isBackground = SHELL_TOOLS.has(tool)
    && typeof exec.arguments === 'object' && exec.arguments !== null
    && (exec.arguments as { run_in_background?: unknown }).run_in_background === true
  const command = isBackground ? undefined : shellCommand(tool, exec.arguments)
  const text = shellText(result.content)
  const { exitCode, interrupted } = SHELL_TOOLS.has(tool)
    ? shellExitStatus(text)
    : { exitCode: undefined, interrupted: false }
  return {
    callId: exec.callId,
    tool,
    canonicalArgs: canonicalizeArgs(exec.arguments),
    command,
    resultHash: sha256(JSON.stringify(result.content)),
    isError: result.isError,
    mutation: MUTATION_TOOLS.has(tool) && !result.isError,
    exitCode,
    interrupted,
  }
}

/** The session-log event subset the replay translator consumes. */
export type ReplayEvent =
  | { type: 'tool/call'; data: { callId: string; name: string; arguments: string } }
  | { type: 'tool/result'; data: { message: { content: readonly [{ callId: string; content: ContentBlock[]; isError: boolean }] } } }

/**
 * Translate session-log events (in log order) into the engine event stream:
 * pair each `tool/result` with its `tool/call`, skipping orphans (pruned or
 * crashed tails). Compaction may have rewritten result content — replay
 * reflects the CURRENT log, which is authoritative.
 */
export function translateSessionEvents(events: readonly ReplayEvent[]): EngineEvent[] {
  const pending = new Map<string, { callId: string; name: string; arguments: string }>()
  const out: EngineEvent[] = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      pending.set(event.data.callId, { callId: event.data.callId, name: event.data.name, arguments: event.data.arguments })
    } else {
      const block = event.data.message.content[0]
      const call = pending.get(block.callId)
      if (call === undefined) continue
      out.push(toEngineEvent(
        { callId: call.callId, name: call.name, arguments: parseArguments(call.arguments) },
        { content: block.content, isError: block.isError },
      ))
    }
  }
  return out
}

/**
 * The assistant's most recent non-empty text, scanned backward through the
 * session log's `assistant/message` events. Completion-claim checking (rule
 * 3) triggers only on this text; without one the rule is inert. Reading the
 * durable log keeps the guard consistent with what the model last said even
 * after resume.
 */
export function lastAssistantText(session: Session | undefined): string | undefined {
  if (session === undefined) return undefined
  const events = session.events
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type !== 'assistant/message') continue
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (text.trim().length > 0) return text
  }
  return undefined
}

/**
 * P5 — capability router.
 *
 * Task-profile tool disclosure (PLAN 3.4): a stable core tool set is always
 * available, each task profile adds its instruments, and the router applies
 * the profile as a `ctx.tools.restrict({ allow })` on the agent scope before
 * its first model request. v0.1 is a static profile chosen at config time
 * (benchmark manifests declare it); automatic progressive disclosure lands
 * in v0.2. The restrict allow-list only ever names tools actually registered
 * at application time — `restrict` fails loudly on unknown names, so the
 * router filters its profile against the registry's global view first.
 */

/** Task-presentation profiles (PLAN 3.4). */
export type TaskProfile = 'coding' | 'research' | 'minimal'

/** The stable core set — always available regardless of profile (PLAN 3.4). */
export const CORE_TOOL_NAMES: readonly string[] = ['read', 'write', 'edit', 'bash', 'todo_write']

/**
 * Registered tool names per profile (PLAN 3.4 v0.1). Names are DSH registry
 * names as verified against the codebase: the fs-search package registers
 * `grep`/`glob`, the str-replace editor registers `str_replace_editor`,
 * subagent/workflow tools default to `subagent`/`workflow`, and the web tool
 * registers `web_search`/`web_fetch`.
 */
export const PROFILE_TOOL_NAMES: Readonly<Record<TaskProfile, readonly string[]>> = {
  coding: [...CORE_TOOL_NAMES, 'grep', 'glob', 'str_replace_editor', 'subagent', 'workflow'],
  research: [...CORE_TOOL_NAMES, 'web_search', 'web_fetch'],
  minimal: [...CORE_TOOL_NAMES],
}

/**
 * Resolve a profile's allow-list restricted to the tools actually present,
 * so `ctx.tools.restrict` never fails on an unregistered name. Undefined when
 * nothing of the profile is present — no restriction then.
 * @param profile - the task profile to apply.
 * @param known - globally registered tool names at application time.
 * @returns the safe allow-list restriction, or undefined.
 */
export function resolveToolRestriction(profile: TaskProfile, known: readonly string[]): { readonly allow: readonly string[] } | undefined {
  const allow = PROFILE_TOOL_NAMES[profile].filter(name => known.includes(name))
  return allow.length > 0 ? { allow } : undefined
}

/**
 * Install the governor's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.logger?.info('[orcana-governor] activated mode=%s', config.governor.mode)
  const engines = new WeakMap<Agent, ProgressFactEngine>()
  /** Governor-issued forced continuations per agent (reset on user interjection). */
  const forced = new WeakMap<Agent, number>()

  function engineFor(agent: Agent | undefined): ProgressFactEngine | undefined {
    if (!agent) return undefined
    let engine = engines.get(agent)
    if (!engine) {
      engine = new ProgressFactEngine({
        fingerprintWindow: config.governor.fingerprintWindow,
        verifyPatterns: config.evidence.verifyCommandPatterns,
        inlineRepeatTools: config.governor.inlineRepeatTools,
      })
      engines.set(agent, engine)
    }
    return engine
  }

  // Evidence presentation: a per-request verification-state snapshot as
  // dynamic system-prompt context (dsh-system-prompt "context", materialized
  // as a durable user-role snapshot — model-visible ⟺ logged holds without
  // extra events). Registered only when evidence is enabled; empty text
  // contributes nothing.
  if (config.evidence.enabled) {
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'orcana:verification-state',
        order: 250,
        text: (context) => {
          const agent = context.agent
          const engine = agent === undefined ? undefined : engines.get(agent)
          if (engine === undefined) return ''
          return renderVerificationState(
            engine.snapshot().receipts,
            engine.currentGeneration(),
            config.evidence.freshness === 'generation',
          ) ?? ''
        },
      })
    })
  }

  // Capability router (P5): apply the configured task profile to each agent
  // scope before its first model request. Static v0.1 — the profile is chosen
  // at config time (benchmark manifests declare it), and the restriction's
  // disposer (the manual lift) is left to the agent scope's lifecycle: it
  // unwinds automatically on agent disposal.
  if (config.tools.disclosure === 'task-profile') {
    ctx.on('agent/created', ({ agent }) => {
      const known = PROFILE_TOOL_NAMES[config.tools.defaultProfile]
        .filter(name => ctx.tools.get(name) !== undefined)
      const restriction = resolveToolRestriction(config.tools.defaultProfile, known)
      if (restriction === undefined) return
      agent.ctx.tools.restrict(restriction)
      ctx.logger?.info(
        '[orcana-governor] capability router: %s profile, allow %d tools',
        config.tools.defaultProfile,
        restriction.allow.length,
      )
    })
  }

  // Observe-and-enrich, never veto: advance state first, DELEGATE so a later
  // listener can still block or replace, then fold our contexts onto the
  // downstream decision. In-round repeat reminders ride additionalContexts,
  // which the agent loop logs as plugin-source user/message events at the
  // next step boundary (agent.ts:283/395) — model-visible ⟺ logged holds.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const engine = engineFor(exec.agent)
    let reminder: string | undefined
    if (engine !== undefined) {
      const signal = engine.applyEvent(toEngineEvent(exec, result))
      reminder = engine.consumeInlineReminder()
      if (config.governor.enabled) {
        ctx.logger?.debug('[orcana-governor] %s → %s @gen%d', exec.name, signal.kind, engine.currentGeneration())
      }
    }
    const downstream = await next()
    if (reminder === undefined) return downstream
    const message = createUserMessage({
      content: [{ type: 'text', text: reminder }],
      source: { kind: 'plugin', plugin: 'orcana-governor', form: 'notice', summary: 'repeated call' },
    })
    const contexts: UserMessage[] = [message, ...(downstream.additionalContexts ?? [])]
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: contexts }
    }
    return { ...downstream, additionalContexts: contexts }
  })

  // A user interjection changes the context; repetition across it is not a
  // loop. Reset the zero-progress chain and the forced-continuation budget;
  // governor steers (plugin source) never reset. Pure reset hook: delegates.
  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) {
      engines.get(agent)?.resetChains()
      forced.delete(agent)
    }
    return next()
  })

  // The model is about to stop: settle the round, escalate the zero-progress
  // ladder (bounded by maxForcedContinuations), then — when the ladder has
  // nothing to say — run the evidence-bound completion guard (PLAN 3.3).
  // Both paths share one forced-continuation budget per agent; a steer from
  // either consumes a unit and is reported as a plugin-source user message.
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const engine = engines.get(agent)
    if (engine === undefined) return
    const verdict = engine.endTurn()
    const forcedCount = forced.get(agent) ?? 0
    const decision = decideSteer(verdict, {
      enabled: config.governor.enabled,
      mode: config.governor.mode,
      thresholds: config.governor.zeroProgressThresholds,
      maxForced: config.completion.maxForcedContinuations,
    }, forcedCount)
    if (decision.action === 'steer' && decision.text !== undefined) {
      forced.set(agent, forcedCount + 1)
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: decision.text }],
        source: {
          kind: 'plugin',
          plugin: 'orcana-governor',
          form: 'notice',
          summary: `zero-progress round ${verdict.chainLength}`,
        },
      }))
      ctx.logger?.debug('[orcana-governor] steered after %d zero-progress rounds', verdict.chainLength)
      return
    }
    if (config.completion.mode !== 'evidence-bound') return
    if (forcedCount >= config.completion.maxForcedContinuations) return
    const violations = completionViolations(
      {
        generation: engine.currentGeneration(),
        receipts: engine.snapshot().receipts,
      },
      lastAssistantText(agent.session),
      {
        claimCheck: config.completion.claimCheck,
        claimPatterns: config.completion.claimPatterns,
        verifyPatterns: config.evidence.verifyCommandPatterns,
      },
    )
    const text = renderCompletionSteer(violations)
    if (text === undefined) return
    forced.set(agent, forcedCount + 1)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'orcana-governor',
        form: 'notice',
        summary: `completion evidence (${violations.length} violation${violations.length === 1 ? '' : 's'})`,
      },
    }))
    ctx.logger?.debug('[orcana-governor] completion guard steered (%d violations)', violations.length)
  })

  // Cleanup runs at context disposal (cordis 'dispose' is not a typed event).
  ctx.effect(() => () => {
    ctx.logger?.info('[orcana-governor] disposed')
  })
}