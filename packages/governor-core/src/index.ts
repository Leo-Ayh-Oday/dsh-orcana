/**
 * @leooday/governor-core — framework-agnostic progress-fact engine.
 *
 * The pure core of the Orcana runtime pack. It classifies tool observations
 * into progress signals and tracks workspace generation and verification
 * receipts. It imports no Cordis and no DSH service; the adapter plugin
 * (@leooday/dsh-governor) feeds it through {@link EngineEvent} and consumes
 * its signals. Keeping the core framework-free lets it serve Orcana, DSH, or
 * other harnesses later.
 *
 * P1: the engine consumes one normalized event stream — {@link applyEvent} is
 * the single state-transition path used by BOTH the live adapter and the
 * session-log replay ({@link ProgressFactEngine.rebuild}), so live state and
 * resumed state cannot drift by construction.
 * @module @leooday/governor-core
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

/** One fingerprint retained in the recent-observation ring. */
export interface RingEntry extends ToolObservation {
  /** Workspace generation when the observation was recorded. */
  readonly generation: number
}

/**
 * One normalized tool-result event consumed by the engine. The adapter builds
 * these identically for live observations and for session-log replay, so the
 * engine never needs to know the host harness.
 */
export interface EngineEvent {
  /** Call identity pairing this event with its tool call. */
  readonly callId: string
  readonly tool: string
  /** Deep key-sorted canonical arguments JSON. */
  readonly canonicalArgs: string
  /**
   * Normalized shell command (the tool's `command` argument, trimmed) — the
   * verification identity. Undefined outside shell tools and for background
   * acknowledgements (no terminal exit status), which never yield receipts.
   */
  readonly command: string | undefined
  readonly resultHash: string
  readonly isError: boolean
  /** Mutation-tool success — the adapter decides (mutation tool && !isError). */
  readonly mutation: boolean
  /** Shell exit code recovered from the rendered result text; undefined when absent (clean exit 0). */
  readonly exitCode: number | undefined
  /** Shell outcome was interrupted (timeout / signal) — receipt status 'unknown'. */
  readonly interrupted: boolean
}

/** How one observation classifies against the engine's recent history. */
export type ProgressSignal =
  | { readonly kind: 'first-observation' }
  | { readonly kind: 'progress' }
  | { readonly kind: 'new-evidence' }
  | { readonly kind: 'repeated-observation' }

/** Verification outcome recorded against one workspace generation. */
export interface VerificationReceipt {
  /** Canonical command identity (the normalized shell command). */
  readonly command: string
  readonly resultHash: string
  /** Workspace generation at verification time; a later generation makes this stale. */
  readonly generation: number
  readonly status: 'pass' | 'fail' | 'unknown'
  readonly callId: string
}

/** Durable engine state — resume replays the session log into this. */
export interface EngineSnapshot {
  readonly generation: number
  readonly ring: readonly RingEntry[]
  readonly receipts: readonly VerificationReceipt[]
}

/** Engine construction options; every deployment-varying choice is explicit. */
export interface ProgressFactEngineOptions {
  /** Recent-observation window (default 8): a repeated call seen within the window counts. */
  readonly fingerprintWindow?: number
  /** Verification-command first-verb patterns (default the JS-ecosystem set). */
  readonly verifyPatterns?: readonly string[]
  /** Tool-name wildcard patterns that get in-round repeat reminders (default read/bash/search — the tools the coordinated repeat-tool-reminder exclude leaves to the governor). */
  readonly inlineRepeatTools?: readonly string[]
  /** Consecutive same-fingerprint repeats in one round that trigger the in-round reminder (default 2). */
  readonly inlineRepeatThreshold?: number
}

/** Default verification first-verb patterns (JS-ecosystem focus of the v0.1 benchmark). */
export const DEFAULT_VERIFY_PATTERNS: readonly string[] = ['test', 'typecheck', 'build', 'check', 'lint']

/** Default recent-observation window. */
export const DEFAULT_FINGERPRINT_WINDOW = 8

/** Default in-round repeat-reminder tool patterns (aligned with the coordinated repeat-tool-reminder exclude). */
export const DEFAULT_INLINE_REPEAT_TOOLS: readonly string[] = ['read', 'bash', '*search*']

/** Default consecutive repeats in one round that trigger the in-round reminder. */
export const DEFAULT_INLINE_REPEAT_THRESHOLD = 2

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
 * Classify one observation against the ring entries of the current
 * generation. Conservative by design: only objective signals count as
 * non-repetition. Within the current generation, an exact (tool, args, hash)
 * match anywhere in the window is a repeated observation (so alternating
 * repeats like A-B-A are caught, not just last-call repeats); the same
 * (tool, args) with a different result is new evidence; anything else is
 * progress. A generation advance invalidates older entries, so the first
 * observation of a new generation classifies as first-observation (never
 * repeated).
 */
export function classifyObservation(
  history: readonly RingEntry[],
  observation: ToolObservation,
  generation: number,
): ProgressSignal {
  const current = history.filter(entry => entry.generation === generation)
  if (current.length === 0) return { kind: 'first-observation' }
  const sameCall = (entry: RingEntry): boolean =>
    entry.tool === observation.tool && entry.canonicalArgs === observation.canonicalArgs
  if (current.some(entry => sameCall(entry) && entry.resultHash === observation.resultHash)) {
    return { kind: 'repeated-observation' }
  }
  if (current.some(sameCall)) return { kind: 'new-evidence' }
  return { kind: 'progress' }
}

/**
 * First-verb token of a shell command for verification matching:
 * `npm test` → `test`, `pnpm run build` → `build`, `pnpm run build:all`
 * → `build:all`, `npx vitest run` → `vitest`, `cargo test` → `cargo`.
 * Package-manager verbs (npm/pnpm/yarn/npx) resolve to their subcommand so
 * `grep -r test src` never matches a `test` pattern (its verb is `grep`).
 */
export function verificationToken(tool: string, command: string | undefined): string | undefined {
  if (command === undefined) return undefined
  const words = command.trim().split(/\s+/).filter(word => word.length > 0)
  if (words.length === 0) return undefined
  const verb = words[0]!.split(/[\\/]/).pop()!
  if (verb === 'npm' || verb === 'pnpm' || verb === 'yarn' || verb === 'npx') {
    const sub = words[1]
    if (sub === undefined) return verb
    if (sub === 'run' || sub === 'exec') return words[2] ?? sub
    return sub
  }
  return verb
}

/** Whether a token matches one verification pattern: exact, or segment-prefixed (`build:all` matches `build`). */
export function matchesVerificationPattern(token: string, pattern: string): boolean {
  return token === pattern || token.startsWith(`${pattern}:`)
}

/** Whether an observation is a verification command under the given patterns. */
export function isVerificationCommand(
  tool: string,
  command: string | undefined,
  patterns: readonly string[],
): boolean {
  const token = verificationToken(tool, command)
  return token !== undefined && patterns.some(pattern => matchesVerificationPattern(token, pattern))
}

/**
 * Receipt status from one engine event. Interruption (timeout / signal)
 * dominates — the command did not finish, its outcome is unknown even when an
 * exit marker survived. Otherwise the exit marker decides; without one a
 * non-error result is a clean exit 0.
 */
export function receiptStatus(
  event: Pick<EngineEvent, 'interrupted' | 'exitCode' | 'isError'>,
): VerificationReceipt['status'] {
  if (event.interrupted) return 'unknown'
  if (event.exitCode !== undefined) return event.exitCode === 0 ? 'pass' : 'fail'
  if (event.isError) return 'fail'
  return 'pass'
}

/**
 * Per-agent progress-fact state: workspace generation, a recent-observation
 * ring, and the latest verification receipt per command. Pure state — the
 * adapter decides what reaches the model, and resume replays the session log
 * through {@link ProgressFactEngine.rebuild}.
 */
export class ProgressFactEngine {
  private readonly window: number
  private readonly patterns: readonly string[]
  private readonly inlineTools: readonly string[]
  private readonly inlineThreshold: number
  private generation = 0
  private readonly ring: RingEntry[] = []
  private readonly receipts = new Map<string, VerificationReceipt>()
  private chain = 0
  private turn: TurnState | undefined

  constructor(options: ProgressFactEngineOptions = {}) {
    this.window = options.fingerprintWindow ?? DEFAULT_FINGERPRINT_WINDOW
    this.patterns = options.verifyPatterns ?? DEFAULT_VERIFY_PATTERNS
    this.inlineTools = options.inlineRepeatTools ?? DEFAULT_INLINE_REPEAT_TOOLS
    this.inlineThreshold = options.inlineRepeatThreshold ?? DEFAULT_INLINE_REPEAT_THRESHOLD
    if (this.window < 1) {
      throw new Error('fingerprintWindow must be a positive integer')
    }
    if (this.patterns.length === 0) {
      throw new Error('verifyPatterns must not be empty')
    }
    if (this.inlineThreshold < 2) {
      throw new Error('inlineRepeatThreshold must be >= 2')
    }
  }

  /** Current workspace generation (0 = pristine). */
  currentGeneration(): number {
    return this.generation
  }

  /** Advance the workspace generation — a mutation completed. */
  onMutation(): void {
    this.generation += 1
  }

  /**
   * The single state transition: classify against the ring, record the
   * fingerprint, apply the mutation, and record a verification receipt when
   * the event is one. Live observations and log replay both go through here,
   * so the two paths cannot drift.
   * @returns the classification signal of this observation.
   */
  applyEvent(event: EngineEvent): ProgressSignal {
    const observation: ToolObservation = {
      tool: event.tool,
      canonicalArgs: event.canonicalArgs,
      resultHash: event.resultHash,
    }
    const signal = classifyObservation(this.ring, observation, this.generation)
    this.ring.push({ ...observation, generation: this.generation })
    if (this.ring.length > this.window) this.ring.shift()
    if (event.mutation) this.generation += 1

    const verification = event.command !== undefined
      && isVerificationCommand(event.tool, event.command, this.patterns)
    if (verification) {
      const firstSeen = !this.receipts.has(event.command)
      this.recordReceipt({
        command: event.command,
        resultHash: event.resultHash,
        generation: this.generation,
        status: receiptStatus(event),
        callId: event.callId,
      })
      this.observeTurn(signal, observation, verification, {
        firstSeen,
        pass: receiptStatus(event) === 'pass',
      })
    } else {
      this.observeTurn(signal, observation, verification, { firstSeen: false, pass: false })
    }
    return signal
  }

  /**
   * Fold one observation into the current round's summary. Round state is
   * lazily created on the first observation and cleared by endTurn.
   */
  private observeTurn(
    signal: ProgressSignal,
    observation: ToolObservation,
    verification: boolean,
    receipt: { firstSeen: boolean; pass: boolean },
  ): void {
    const turn = this.turn ??= newTurnState()
    turn.observations += 1
    if (signal.kind === 'repeated-observation') {
      turn.repeatedPattern = {
        tool: observation.tool,
        canonicalArgs: observation.canonicalArgs,
      }
    }
    // The verification-repeat special case: verification observations never
    // count as significant evidence (their output hash is unstable); only a
    // first-ever verification or a pass receipt marks activity.
    if (verification) {
      if (receipt.firstSeen) turn.verifyNew = true
      if (receipt.pass) turn.verifyPass = true
      return
    }
    if (signal.kind !== 'repeated-observation') {
      turn.significant = true
    }
    // In-round repeat streak: consecutive same-fingerprint observations of an
    // inline tool, independent of the classification signal (the first call of
    // a pair must count, and a changed result hash naturally breaks the streak).
    if (!this.inlineTools.some(pattern => matchWildcard(observation.tool, pattern))) {
      turn.inlineStreak = 0
      turn.inlineFingerprint = undefined
      return
    }
    const key = observation.tool + '|' + observation.canonicalArgs + '|' + observation.resultHash
    turn.inlineStreak = turn.inlineFingerprint === key ? turn.inlineStreak + 1 : 1
    turn.inlineFingerprint = key
    if (turn.inlineStreak >= this.inlineThreshold && !turn.inlineReminderFired) {
      turn.inlineReminder = INLINE_REPEAT_REMINDER
      turn.inlineReminderFired = true
    }
  }

  /** Reset the round summary (idempotent; called by the adapter at round boundaries). */
  beginTurn(): void {
    this.turn = undefined
  }

  /**
   * Settle the current round: aggregate its observations into a verdict and
   * advance or reset the zero-progress chain. Rounds with zero observations
   * leave the chain untouched. Clears the round state for the next round.
   * @returns the verdict for this round.
   */
  endTurn(): TurnVerdict {
    const turn = this.turn
    this.turn = undefined
    if (turn === undefined || turn.observations === 0) {
      return { zeroProgress: false, chainLength: this.chain, repeatedPattern: undefined }
    }
    const zeroProgress = !turn.mutation && !turn.significant && !turn.verifyNew && !turn.verifyPass
    if (zeroProgress) this.chain += 1
    else this.chain = 0
    return {
      zeroProgress,
      chainLength: this.chain,
      repeatedPattern: turn.repeatedPattern,
    }
  }

  /** Clear the zero-progress chain and round state (user interjection). */
  resetChains(): void {
    this.chain = 0
    this.turn = undefined
  }

  /** Current consecutive zero-progress round count. */
  zeroProgressChain(): number {
    return this.chain
  }

  /**
   * The in-round repeat reminder for this round, if one was produced and not
   * yet consumed. The reminder is armed at most once per round; endTurn clears
   * the round state so the next round can arm again.
   */
  consumeInlineReminder(): string | undefined {
    const reminder = this.turn?.inlineReminder
    if (this.turn !== undefined) this.turn.inlineReminder = undefined
    return reminder
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

  /** Serialize engine state for durable resume or tests. */
  snapshot(): EngineSnapshot {
    return {
      generation: this.generation,
      ring: [...this.ring],
      receipts: [...this.receipts.values()],
    }
  }

  /** Replace engine state from a snapshot (resume path). */
  restore(snapshot: EngineSnapshot): void {
    this.generation = snapshot.generation
    this.ring.length = 0
    this.ring.push(...snapshot.ring)
    this.receipts.clear()
    for (const receipt of snapshot.receipts) this.receipts.set(receipt.command, receipt)
  }

  /** Rebuild engine state by replaying events (session-log resume). */
  static rebuild(events: readonly EngineEvent[], options: ProgressFactEngineOptions = {}): ProgressFactEngine {
    const engine = new ProgressFactEngine(options)
    for (const event of events) engine.applyEvent(event)
    return engine
  }
}

/**
 * P2 — turn-level aggregation and zero-progress chain.
 *
 * classify() is per-observation; the escalation ladder counts zero-progress
 * ROUNDS. One round is the interval between the engine's round boundaries
 * (the adapter calls beginTurn/endTurn around a model stop). A round is
 * zero-progress iff it observed at least one tool call AND saw no mutation,
 * no significant new evidence (non-verification progress/new-evidence or
 * first-observation), no first-ever verification command, and no pass
 * receipt. The verification-repeat special case: re-running an already-seen
 * verification command without a pass receipt counts as zero-progress even
 * when its output hash changed (timestamps make test output unstable), which
 * is exactly the repeated-failing-test pattern the governor must catch.
 * Rounds with zero observations neither advance nor reset the chain.
 */

/** One round's aggregation result. */
export interface TurnVerdict {
  /** Whether the round just ended was zero-progress. */
  readonly zeroProgress: boolean
  /** Consecutive zero-progress rounds after this round (0 when this round had progress). */
  readonly chainLength: number
  /** The round's last repeated observation (tool + canonical args) for the strong steer, if any. */
  readonly repeatedPattern: { readonly tool: string; readonly canonicalArgs: string } | undefined
}

/** Model-visible reminder texts — stable strings, snapshot-covered (PLAN 7). */
export const INLINE_REPEAT_REMINDER =
  'You are repeating the exact same call with unchanged results. Take a different action or finish the task.'

/** The gentle first-tier turn reminder. */
export const GENTLE_TURN_REMINDER =
  'You have spent 2 consecutive rounds without progress. Stop repeating investigation and take the next concrete action.'

/** The second-tier turn reminder. */
export const REEVALUATE_TURN_REMINDER =
  'You have spent 3 consecutive rounds without progress. Re-evaluate the current approach before continuing.'

/**
 * The strong steer naming the repeated pattern and the round count.
 * @param chainLength - consecutive zero-progress rounds.
 * @param pattern - the round's repeated observation, when one was seen.
 * @returns the stable strong-steer text (chain length and pattern interpolated).
 */
export function strongTurnReminder(
  chainLength: number,
  pattern: { readonly tool: string; readonly canonicalArgs: string } | undefined,
): string {
  const repeated = pattern === undefined
    ? ''
    : ` Repeated pattern: ${pattern.tool} ${pattern.canonicalArgs}`
  return `You have spent ${chainLength} consecutive rounds without progress.${repeated} Change approach or finish the task.`
}

/**
 * Tiered steer text for a chain length that hit a threshold: the first
 * threshold gets the gentle reminder, the second the re-evaluate reminder,
 * everything from the third threshold on the strong steer.
 * @param chainLength - consecutive zero-progress rounds (must hit `thresholds`).
 * @param pattern - repeated observation for the strong steer.
 * @param thresholds - configured ladder (ascending; at least one entry).
 * @returns the exact reminder text for this tier.
 */
export function steerText(
  chainLength: number,
  pattern: { readonly tool: string; readonly canonicalArgs: string } | undefined,
  thresholds: readonly number[],
): string {
  const index = thresholds.indexOf(chainLength)
  if (index === 0) return GENTLE_TURN_REMINDER
  if (index === 1) return REEVALUATE_TURN_REMINDER
  return strongTurnReminder(chainLength, pattern)
}

/**
 * `*`-wildcard tool-name match (same semantics as repeat-tool-reminder's
 * include/exclude): every other regex metacharacter matches literally.
 */
export function matchWildcard(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`).test(name)
}

/** One round's in-engine state (transient; never snapshotted). */
interface TurnState {
  observations: number
  mutation: boolean
  significant: boolean
  /** A verification command never seen before this round (new verification activity). */
  verifyNew: boolean
  /** A pass receipt landed this round. */
  verifyPass: boolean
  /** Consecutive same-fingerprint repeated-observation streak (inline-reminder input). */
  inlineStreak: number
  inlineFingerprint: string | undefined
  inlineReminder: string | undefined
  /** One reminder per round (PLAN 3.1: one notice per pattern). */
  inlineReminderFired: boolean
  repeatedPattern: { tool: string; canonicalArgs: string } | undefined
}

function newTurnState(): TurnState {
  return {
    observations: 0,
    mutation: false,
    significant: false,
    verifyNew: false,
    verifyPass: false,
    inlineStreak: 0,
    inlineFingerprint: undefined,
    inlineReminder: undefined,
    inlineReminderFired: false,
    repeatedPattern: undefined,
  }
}

/**
 * Render the model-visible verification-state snapshot. Fixed format,
 * snapshot-covered (PLAN 7): one line per command in ascending command order;
 * receipts recorded against an earlier generation are flagged STALE when
 * freshness is on. Undefined when nothing was verified yet — the caller
 * contributes no context then.
 * @param receipts - latest receipt per command (engine snapshot).
 * @param currentGeneration - engine's current workspace generation.
 * @param freshness - whether the `generation` freshness mode is active.
 * @returns the stable snapshot text, or undefined without receipts.
 */
export function renderVerificationState(
  receipts: readonly VerificationReceipt[],
  currentGeneration: number,
  freshness: boolean,
): string | undefined {
  if (receipts.length === 0) return undefined
  const lines = [...receipts]
    .sort((left, right) => left.command.localeCompare(right.command))
    .map((receipt) => {
      const status = receipt.status === 'pass' ? 'PASS' : receipt.status === 'fail' ? 'FAIL' : 'UNKNOWN'
      const stale = freshness && receipt.generation !== currentGeneration
      return `- ${receipt.command}: ${status} @gen${receipt.generation}${stale ? ' STALE' : ''}`
    })
  return `Verification state:\n${lines.join('\n')}`
}
