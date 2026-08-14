/**
 * @orcana/governor-core — framework-agnostic progress-fact engine.
 *
 * The pure core of the Orcana runtime pack. It classifies tool observations
 * into progress signals and tracks workspace generation and verification
 * receipts. It imports no Cordis and no DSH service; the adapter plugin
 * (@orcana/dsh-governor) feeds it and consumes its signals. Keeping the core
 * framework-free lets it serve Orcana, DSH, or other harnesses later.
 * @module @orcana/governor-core
 */

import { createHash } from 'node:crypto'

/** One tool execution normalized for fingerprinting. */
export interface ToolObservation {
  /** Registry tool name (`read`, `bash`, `write`, ...). */
  readonly tool: string
  /** Deep key-sorted JSON string of the call's parsed arguments. */
  readonly canonicalArgs: string
  /** SHA-256 of the result content summary. */
  readonly resultHash: string
}

/** How one observation classifies against the engine's prior state. */
export type ProgressSignal =
  | { readonly kind: 'first-observation' }
  | { readonly kind: 'progress' }
  | { readonly kind: 'new-evidence' }
  | { readonly kind: 'repeated-observation' }

/** Verification outcome recorded against one workspace generation. */
export interface VerificationReceipt {
  /** Canonical command identity (tool name + canonical args). */
  readonly command: string
  readonly resultHash: string
  /** Workspace generation at verification time; a later generation makes this stale. */
  readonly generation: number
  readonly status: 'pass' | 'fail' | 'unknown'
  readonly callId: string
}

/** SHA-256 hex digest of a string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Deep key-sort of a parsed-JSON value so objects that differ only in
 * property order canonicalize identically. The input domain is lossless JSON
 * (tool arguments), so no bigint, cycle, or `undefined` handling exists.
 */
export function canonicalizeArgs(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/**
 * Progress classification for one observation against the prior one.
 * Conservative by design: only objective signals count as progress
 * (generation advanced, new result content). Same call + same result at the
 * same generation is a repeated observation; same call with a changed result
 * is new evidence.
 */
export function classify(
  prior: ToolObservation | undefined,
  current: ToolObservation,
  priorGeneration: number,
  currentGeneration: number,
): ProgressSignal {
  if (prior === undefined) return { kind: 'first-observation' }
  if (priorGeneration !== currentGeneration) return { kind: 'progress' }
  const sameCall = prior.tool === current.tool && prior.canonicalArgs === current.canonicalArgs
  if (sameCall && prior.resultHash === current.resultHash) return { kind: 'repeated-observation' }
  if (sameCall) return { kind: 'new-evidence' }
  return { kind: 'progress' }
}

/**
 * Per-agent progress-fact state: workspace generation, the last observation
 * fingerprint, and the latest verification receipt per command. Pure state —
 * the adapter decides what reaches the model, and resumes replay this state
 * from the session log.
 */
export class ProgressFactEngine {
  private generation = 0
  private last: { observation: ToolObservation; generation: number } | undefined
  private readonly receipts = new Map<string, VerificationReceipt>()

  /** Current workspace generation (0 = pristine). */
  currentGeneration(): number {
    return this.generation
  }

  /** Advance the workspace generation — a mutation completed. */
  onMutation(): void {
    this.generation += 1
  }

  /** Classify one observation against engine state and advance the fingerprint. */
  observe(observation: ToolObservation): ProgressSignal {
    const signal = classify(
      this.last?.observation,
      observation,
      this.last?.generation ?? this.generation,
      this.generation,
    )
    this.last = { observation, generation: this.generation }
    return signal
  }

  /** Store the latest receipt for its command (keyed by canonical command). */
  recordReceipt(receipt: VerificationReceipt): void {
    this.receipts.set(receipt.command, receipt)
  }

  /** Latest receipt for a command, if any. */
  receiptFor(command: string): VerificationReceipt | undefined {
    return this.receipts.get(command)
  }

  /** A receipt is stale when recorded against an earlier workspace generation. */
  isStale(receipt: VerificationReceipt): boolean {
    return receipt.generation !== this.generation
  }
}
