/**
 * @orcana/dsh-governor — DSH adapter for the Orcana runtime pack.
 *
 * Function plugin mounting the framework-agnostic ProgressFactEngine on DSH
 * extension points: observes `tools/post-execute`, resets on user
 * interjection at `agent/pre-step`, and intercepts `agent/turn-stopping`
 * (completion guard, P4). Model-visible output (steers/reminders) is added in
 * P2 as plugin-source user messages, satisfying the model-visible ⟺ logged
 * invariant. No fork, no agent-loop patch — pure Cordis extensions.
 * @module @orcana/dsh-governor
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { ProgressFactEngine, canonicalizeArgs, sha256 } from '@orcana/governor-core'

export const name = 'orcana-governor'

/** Plugin config — every deployment-varying choice is a validated field. */
export interface Config {
  governor: {
    enabled: boolean
    mode: 'observe' | 'warn-steer' | 'enforce'
    zeroProgressThresholds: number[]
  }
  evidence: {
    enabled: boolean
    freshness: 'generation' | 'off'
    verifyCommandPatterns: string[]
  }
  completion: {
    mode: 'off' | 'evidence-bound'
    maxForcedContinuations: number
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
  }),
  evidence: z.object({
    enabled: z.boolean().default(true),
    freshness: z.union(['generation', 'off'] as const).default('generation'),
    verifyCommandPatterns: z.array(z.string()).default(['test', 'typecheck', 'build', 'check', 'lint']),
  }),
  completion: z.object({
    mode: z.union(['off', 'evidence-bound'] as const).default('evidence-bound'),
    maxForcedContinuations: z.number().default(3),
  }),
  tools: z.object({
    disclosure: z.union(['off', 'task-profile'] as const).default('task-profile'),
    defaultProfile: z.union(['coding', 'research', 'minimal'] as const).default('coding'),
  }),
})

/** Mutation-typed tools whose successful return advances the workspace generation. */
const MUTATION_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'str_replace'])

/**
 * Install the governor's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.logger?.info('[orcana-governor] activated mode=%s', config.governor.mode)
  const engines = new WeakMap<Agent, ProgressFactEngine>()

  function engineFor(agent: Agent | undefined): ProgressFactEngine | undefined {
    if (!agent) return undefined
    let engine = engines.get(agent)
    if (!engine) {
      engine = new ProgressFactEngine()
      engines.set(agent, engine)
    }
    return engine
  }

  // Observe-and-enrich, never veto: advance state first, DELEGATE so a later
  // listener can still block or replace, then fold our contexts onto the
  // downstream decision (reminders arrive in P2).
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const engine = engineFor(exec.agent)
    if (engine !== undefined) {
      const observation = {
        tool: exec.name,
        canonicalArgs: canonicalizeArgs(exec.arguments),
        resultHash: sha256(JSON.stringify(result.content)),
      }
      const signal = engine.observe(observation)
      if (config.governor.enabled) {
        ctx.logger?.debug('[orcana-governor] %s → %s @gen%d', exec.name, signal.kind, engine.currentGeneration())
        // TODO(P2): zero-progress escalation → steer via additionalContexts
      }
      if (!result.isError && MUTATION_TOOLS.has(exec.name) && config.evidence.enabled) {
        engine.onMutation()
      }
      // TODO(P1): verification-command recognition (config.evidence.verifyCommandPatterns) + receipt recording
    }
    return next()
  })

  // A user interjection changes the context; repetition across it is not a
  // loop. Pure reset hook: always delegates.
  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) {
      // TODO(P2): reset per-agent zero-progress chains
      void agent
    }
    return next()
  })

  // The model is about to stop: completion-guard rules and the
  // forced-continuation cap live here (P4). Parallel listener, no next().
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    // TODO(P4): evidence-bound completion checks (stale receipts, failed-then-no-pass, claim-without-evidence)
    void agent
  })

  // Cleanup runs at context disposal (cordis 'dispose' is not a typed event).
  ctx.effect(() => () => {
    ctx.logger?.info('[orcana-governor] disposed')
  })
}