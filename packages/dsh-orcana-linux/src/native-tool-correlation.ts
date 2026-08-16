import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Stable tool/session identity attached to one native execution receipt. */
export interface NativeToolCorrelation {
  /** Live Agent/Session identity. Absent for direct/agentless tool execution. */
  sessionId?: string
  /** Exact DSH tool-call identity. */
  callId: string
  /** Root model-requested call across nested/composite dispatch. */
  rootCallId: string
  /** Tool whose body owns this async execution context. */
  toolName: string
}

const correlationStorage = new AsyncLocalStorage<NativeToolCorrelation>()

/** Copy/freeze only stable string identity; never retain Agent or execution objects. */
export function correlationFromToolExecution(
  exec: Readonly<Pick<ToolDispatchExecution, 'callId' | 'rootCallId' | 'name' | 'agent'>>,
): NativeToolCorrelation {
  return Object.freeze({
    ...(exec.agent !== undefined ? { sessionId: exec.agent.id } : {}),
    callId: exec.callId,
    rootCallId: exec.rootCallId,
    toolName: exec.name,
  })
}

/** Current correlation inherited through the tool body's asynchronous chain. */
export function currentNativeToolCorrelation(): NativeToolCorrelation | undefined {
  const correlation = correlationStorage.getStore()
  return correlation === undefined ? undefined : { ...correlation }
}

/**
 * Run an operation under one exact correlation. Exported for composability and
 * deterministic concurrency tests; production callers normally use the
 * `tools/execute` listener installed below.
 */
export function runWithNativeToolCorrelation<T>(
  correlation: NativeToolCorrelation,
  operation: () => T,
): T {
  return correlationStorage.run(Object.freeze({ ...correlation }), operation)
}

/**
 * Bind DSH's official around-dispatch seam to the process-local async context.
 * `next()` still owns the entire tool body; no arguments, result, signal or
 * policy are changed. Nested tool dispatch naturally shadows the outer store
 * and restores it when the nested body returns.
 */
export function installNativeToolCorrelation(ctx: Context): void {
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const correlation = correlationFromToolExecution(exec)
    return await runWithNativeToolCorrelation(correlation, next)
  })
}
