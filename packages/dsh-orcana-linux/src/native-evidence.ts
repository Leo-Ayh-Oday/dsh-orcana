import { createHash } from 'node:crypto'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  SandboxExecutionPolicy,
  SandboxReceipt,
} from '@deepseek-ai/dsh-sandbox'
import type {
  ShellExecSpec,
  ShellExecutor,
  ShellProcess,
  ShellRunResult,
  ShellSandboxInfo,
} from '@deepseek-ai/dsh-shell'
import {
  currentNativeToolCorrelation,
  installNativeToolCorrelation,
  type NativeToolCorrelation,
} from './native-tool-correlation.js'

/** Legacy package-root resource vocabulary retained only to fail loud on migration. */
export interface LegacyHardeningResourceLimits {
  memoryBytes?: number
  cpuQuotaUs?: number
  pidsMax?: number
}

/** Legacy package-root degradation vocabulary retained only to fail loud on migration. */
export interface LegacyHardeningDegradationPolicy {
  resourceLimits?: 'required' | 'best-effort'
  network?: 'required' | 'best-effort'
}

/**
 * Native observer configuration. Enforcement remains owned by DSH
 * sandbox-policy/provider.
 *
 * Deprecated enforcement fields intentionally remain in the schema so an
 * upgraded profile cannot have an old request silently stripped by
 * schemastery. Their presence fails loud at mount.
 */
export interface NativeEvidenceConfig {
  ledgerMaxEntries?: number
  /** @deprecated Move to DSH's `sandbox-policy.resourceLimits`. */
  resourceLimits?: LegacyHardeningResourceLimits
  /** @deprecated Move to DSH's `sandbox-policy.network`. */
  network?: 'inherit' | 'none'
  /** @deprecated DSH reports degradation in SandboxReceipt. */
  degradationPolicy?: LegacyHardeningDegradationPolicy
  /** @deprecated Native evidence never probes or overrides enforcement. */
  capabilities?: unknown
}

export const DEFAULT_NATIVE_EVIDENCE_LEDGER_MAX_ENTRIES = 1024

export const Config: z<NativeEvidenceConfig> = z.object({
  ledgerMaxEntries: z.number().min(1),
  resourceLimits: z.object({
    memoryBytes: z.number().min(0),
    cpuQuotaUs: z.number().min(0),
    pidsMax: z.number().min(0),
  }).default(undefined as never),
  network: z.union(['inherit', 'none'] as const),
  degradationPolicy: z.object({
    resourceLimits: z.union(['required', 'best-effort'] as const),
    network: z.union(['required', 'best-effort'] as const),
  }).default(undefined as never),
  capabilities: z.any(),
})

export const DUPLICATE_NATIVE_EVIDENCE_INSTANCE = 'DUPLICATE_NATIVE_EVIDENCE_INSTANCE'

export class DuplicateNativeEvidenceError extends Error {
  code: typeof DUPLICATE_NATIVE_EVIDENCE_INSTANCE = DUPLICATE_NATIVE_EVIDENCE_INSTANCE
  constructor() {
    super('a dsh-orcana native-evidence observer already owns this shell provider — dispose it before mounting another')
    this.name = 'DuplicateNativeEvidenceError'
  }
}

export const LEGACY_HARDENING_CONFIG_MOVED = 'LEGACY_HARDENING_CONFIG_MOVED'

export class LegacyHardeningConfigMovedError extends Error {
  code: typeof LEGACY_HARDENING_CONFIG_MOVED = LEGACY_HARDENING_CONFIG_MOVED
  constructor(readonly fields: readonly string[]) {
    super(
      'dsh-orcana-linux/native-evidence: legacy enforcement config is still present '
      + `(${fields.join(', ')}). DSH now owns native enforcement; move network/resourceLimits to the `
      + '`sandbox-policy` row. `degradationPolicy`/`capabilities` have no evidence-adapter enforcement '
      + 'equivalent. Refusing to mount instead of silently weakening the previous policy.',
    )
    this.name = 'LegacyHardeningConfigMovedError'
  }
}

export interface NativePolicySnapshot {
  mode: SandboxExecutionPolicy['mode']
  workspaceRoot: string
  resourceLimits?: Readonly<{
    memoryBytes?: number
    cpuQuotaUs?: number
    pidsMax?: number
  }>
  network: 'inherit' | 'none'
}

export interface NativeReceiptSnapshot {
  layers: readonly string[]
  degraded: readonly string[]
  limitsMechanism?: 'cgroup-v2' | 'prlimit' | 'none'
  cgroupPath?: string
  memoryPeakBytes?: number
  cpuUsageUs?: number
  pidsPeak?: number
  cleanupVerified: boolean
  live?: Readonly<{ current: number; peak: number; total: number }>
}

export interface NativeSandboxSnapshot {
  mode: ShellSandboxInfo['mode']
  denied: boolean
  enforcement?: ShellSandboxInfo['enforcement']
  runnerFailed?: boolean
  receipt?: NativeReceiptSnapshot
}

export type NativeEvidenceKind = 'native-receipt' | 'sandbox-facts' | 'none'
export type NativeExecutionKind = 'foreground' | 'background'
export type NativeExecutionOutcome = 'completed' | 'infrastructure-error'

/**
 * Final execution evidence derived from DSH's public tool/shell/sandbox
 * contracts. Raw command text is intentionally absent; only a SHA-256
 * fingerprint and byte length are retained.
 */
export interface NativeExecutionRecord {
  startedAt: number
  finishedAt: number
  durationMs: number
  kind: NativeExecutionKind
  outcome: NativeExecutionOutcome
  commandHash: string
  commandBytes: number
  workdir: string
  /** Exact DSH causal identity when this shell work ran under ToolRuntime. */
  correlation?: NativeToolCorrelation
  policy?: NativePolicySnapshot
  evidenceKind: NativeEvidenceKind
  sandbox?: NativeSandboxSnapshot
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  timedOut?: boolean
  aborted?: boolean
  /** Infrastructure failures expose routing identity only, never the error message. */
  error?: Readonly<{ name?: string; code?: string }>
}

/**
 * Causal selector over the bounded evidence window. Supplying multiple fields
 * is conjunctive. At least one field is required; use {@link NativeExecutionEvidenceService.ledger}
 * when the caller intentionally wants the whole current window.
 */
export interface NativeEvidenceQuery {
  sessionId?: string
  callId?: string
  rootCallId?: string
  toolName?: string
}

interface NativeExecutionStartSnapshot {
  startedAt: number
  commandHash: string
  commandBytes: number
  workdir: string
  correlation?: NativeToolCorrelation
  policy?: NativePolicySnapshot
}

interface NativeEvidenceLedgerState {
  records: NativeExecutionRecord[]
  dropped: number
  total: number
  pendingBackground: number
  maxEntries: number
}

function createLedgerState(maxEntries: number): NativeEvidenceLedgerState {
  return { records: [], dropped: 0, total: 0, pendingBackground: 0, maxEntries }
}

function resizeLedgerState(state: NativeEvidenceLedgerState, maxEntries: number): void {
  state.maxEntries = maxEntries
  while (state.records.length > maxEntries) {
    state.records.shift()
    state.dropped += 1
  }
}

/**
 * Freeze only Orcana-owned snapshot data. Records are built entirely from
 * detached primitives/arrays/plain objects, so recursively freezing them cannot
 * mutate DSH's original ShellRunResult, SandboxReceipt, spec, or process handle.
 */
function freezeEvidenceValue<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== 'object' || value === null) return value
  const objectValue = value as object
  if (seen.has(objectValue) || Object.isFrozen(objectValue)) return value
  seen.add(objectValue)
  for (const nested of Object.values(objectValue as Record<string, unknown>)) {
    freezeEvidenceValue(nested, seen)
  }
  return Object.freeze(value) as T
}

function pushRecord(state: NativeEvidenceLedgerState, record: NativeExecutionRecord): void {
  const frozen = freezeEvidenceValue(record)
  state.total += 1
  if (state.records.length >= state.maxEntries) {
    state.records.shift()
    state.dropped += 1
  }
  state.records.push(frozen)
}

function assertEvidenceQuery(query: NativeEvidenceQuery): void {
  if (query.sessionId === undefined
    && query.callId === undefined
    && query.rootCallId === undefined
    && query.toolName === undefined) {
    throw new Error('native evidence query requires at least one causal field')
  }
}

function matchesEvidenceQuery(record: NativeExecutionRecord, query: NativeEvidenceQuery): boolean {
  const correlation = record.correlation
  if (correlation === undefined) return false
  if (query.sessionId !== undefined && correlation.sessionId !== query.sessionId) return false
  if (query.callId !== undefined && correlation.callId !== query.callId) return false
  if (query.rootCallId !== undefined && correlation.rootCallId !== query.rootCallId) return false
  if (query.toolName !== undefined && correlation.toolName !== query.toolName) return false
  return true
}

export class NativeExecutionEvidenceService extends Service {
  constructor(ctx: Context, private readonly state: NativeEvidenceLedgerState) {
    super(ctx, 'orcanaLinuxEvidence')
  }

  /** Runtime-frozen window copy; records and every nested evidence object are frozen at insertion. */
  get ledger(): readonly NativeExecutionRecord[] {
    return Object.freeze([...this.state.records])
  }

  /**
   * Find every record in the current bounded window matching the supplied
   * causal identity. This is intentionally a bounded scan rather than a second
   * mutable index: the default window is 1024 and the ledger remains the sole
   * source of truth.
   */
  find(query: NativeEvidenceQuery): readonly NativeExecutionRecord[] {
    assertEvidenceQuery(query)
    return Object.freeze(this.state.records.filter(record => matchesEvidenceQuery(record, query)))
  }

  /** Latest record in the bounded window matching one causal selector. */
  latest(query: NativeEvidenceQuery): NativeExecutionRecord | undefined {
    assertEvidenceQuery(query)
    for (let i = this.state.records.length - 1; i >= 0; i -= 1) {
      const record = this.state.records[i]!
      if (matchesEvidenceQuery(record, query)) return record
    }
    return undefined
  }

  get totalRecorded(): number {
    return this.state.total
  }

  get droppedCount(): number {
    return this.state.dropped
  }

  get pendingBackground(): number {
    return this.state.pendingBackground
  }

  /** DSH enforces. Orcana observes facts and correlates them to tool/session identity. */
  get scope(): Readonly<{
    enforcementOwner: 'dsh'
    observationSeam: 'shell'
    mutatesExecution: false
    dangerFullAccessObserved: true
  }> {
    return {
      enforcementOwner: 'dsh',
      observationSeam: 'shell',
      mutatesExecution: false,
      dangerFullAccessObserved: true,
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    orcanaLinuxEvidence: NativeExecutionEvidenceService
  }
}

function commandFingerprint(command: string): { commandHash: string; commandBytes: number } {
  return {
    commandHash: createHash('sha256').update(command).digest('hex'),
    commandBytes: Buffer.byteLength(command, 'utf8'),
  }
}

export function snapshotNativePolicy(policy: SandboxExecutionPolicy | undefined): NativePolicySnapshot | undefined {
  if (policy === undefined) return undefined
  const limits = policy.resourceLimits
  return {
    mode: policy.mode,
    workspaceRoot: policy.workspaceRoot,
    ...(limits !== undefined ? {
      resourceLimits: {
        ...(limits.memoryBytes !== undefined ? { memoryBytes: limits.memoryBytes } : {}),
        ...(limits.cpuQuotaUs !== undefined ? { cpuQuotaUs: limits.cpuQuotaUs } : {}),
        ...(limits.pidsMax !== undefined ? { pidsMax: limits.pidsMax } : {}),
      },
    } : {}),
    network: policy.network ?? 'inherit',
  }
}

export function snapshotNativeReceipt(receipt: SandboxReceipt | undefined): NativeReceiptSnapshot | undefined {
  if (receipt === undefined) return undefined
  return {
    layers: [...receipt.layers],
    degraded: [...receipt.degraded],
    ...(receipt.limitsMechanism !== undefined ? { limitsMechanism: receipt.limitsMechanism } : {}),
    ...(receipt.cgroupPath !== undefined ? { cgroupPath: receipt.cgroupPath } : {}),
    ...(receipt.memoryPeakBytes !== undefined ? { memoryPeakBytes: receipt.memoryPeakBytes } : {}),
    ...(receipt.cpuUsageUs !== undefined ? { cpuUsageUs: receipt.cpuUsageUs } : {}),
    ...(receipt.pidsPeak !== undefined ? { pidsPeak: receipt.pidsPeak } : {}),
    cleanupVerified: receipt.cleanupVerified,
    ...(receipt.live !== undefined ? { live: { ...receipt.live } } : {}),
  }
}

export function snapshotNativeSandbox(sandbox: ShellSandboxInfo | undefined): NativeSandboxSnapshot | undefined {
  if (sandbox === undefined) return undefined
  const receipt = snapshotNativeReceipt(sandbox.receipt)
  return {
    mode: sandbox.mode,
    denied: sandbox.denied,
    ...(sandbox.enforcement !== undefined ? { enforcement: sandbox.enforcement } : {}),
    ...(sandbox.runnerFailed !== undefined ? { runnerFailed: sandbox.runnerFailed } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
  }
}

export function nativeEvidenceKind(sandbox: ShellSandboxInfo | undefined): NativeEvidenceKind {
  if (sandbox?.receipt !== undefined) return 'native-receipt'
  if (sandbox !== undefined) return 'sandbox-facts'
  return 'none'
}

function infrastructureError(error: unknown): NativeExecutionRecord['error'] {
  if (typeof error !== 'object' || error === null) return {}
  const candidate = error as { name?: unknown; code?: unknown }
  return {
    ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
  }
}

function executionStartSnapshot(spec: ShellExecSpec): NativeExecutionStartSnapshot {
  const correlation = currentNativeToolCorrelation()
  return {
    startedAt: Date.now(),
    ...commandFingerprint(spec.command),
    workdir: spec.workdir,
    ...(correlation !== undefined ? { correlation } : {}),
    ...(spec.sandboxPolicy !== undefined ? { policy: snapshotNativePolicy(spec.sandboxPolicy) } : {}),
  }
}

function recordBase(start: NativeExecutionStartSnapshot, finishedAt: number) {
  return {
    startedAt: start.startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - start.startedAt),
    commandHash: start.commandHash,
    commandBytes: start.commandBytes,
    workdir: start.workdir,
    ...(start.correlation !== undefined ? { correlation: { ...start.correlation } } : {}),
    ...(start.policy !== undefined ? { policy: start.policy } : {}),
  }
}

function completedForegroundRecord(
  start: NativeExecutionStartSnapshot,
  result: ShellRunResult,
  finishedAt: number,
): NativeExecutionRecord {
  const sandbox = snapshotNativeSandbox(result.sandbox)
  return {
    ...recordBase(start, finishedAt),
    kind: 'foreground',
    outcome: 'completed',
    evidenceKind: nativeEvidenceKind(result.sandbox),
    ...(sandbox !== undefined ? { sandbox } : {}),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
  }
}

function completedBackgroundRecord(
  start: NativeExecutionStartSnapshot,
  process: ShellProcess,
  finishedAt: number,
): NativeExecutionRecord {
  const sandbox = snapshotNativeSandbox(process.sandbox)
  return {
    ...recordBase(start, finishedAt),
    kind: 'background',
    outcome: 'completed',
    evidenceKind: nativeEvidenceKind(process.sandbox),
    ...(sandbox !== undefined ? { sandbox } : {}),
    exitCode: process.exitCode,
    signal: process.signal,
  }
}

function rejectedRecord(
  kind: NativeExecutionKind,
  start: NativeExecutionStartSnapshot,
  error: unknown,
  finishedAt: number,
): NativeExecutionRecord {
  return {
    ...recordBase(start, finishedAt),
    kind,
    outcome: 'infrastructure-error',
    evidenceKind: 'none',
    error: infrastructureError(error),
  }
}

interface ObserverPatchState {
  owner: symbol
  originalRun: ShellExecutor['run']
  wrappedRun: ShellExecutor['run']
  originalStart: ShellExecutor['start']
  wrappedStart: ShellExecutor['start']
}

const OBSERVER_PATCH_STATE = Symbol.for('orcana.dsh-orcana-linux.nativeEvidence.patchState')
const EVIDENCE_LEDGER_STATE = Symbol.for('orcana.dsh-orcana-linux.nativeEvidence.ledgerState')
type PatchableShell = ShellExecutor & Record<symbol, unknown> & {
  run: ShellExecutor['run']
  start: ShellExecutor['start']
}

function legacyHardeningFields(config: NativeEvidenceConfig): string[] {
  const fields: string[] = []
  if (config.resourceLimits !== undefined) fields.push('resourceLimits')
  if (config.network !== undefined) fields.push('network')
  if (config.degradationPolicy !== undefined) fields.push('degradationPolicy')
  if (config.capabilities !== undefined) fields.push('capabilities')
  return fields
}

export function validateNativeEvidenceConfig(config: NativeEvidenceConfig): void {
  const maxEntries = config.ledgerMaxEntries
  if (maxEntries !== undefined && (!Number.isInteger(maxEntries) || maxEntries < 1)) {
    throw new Error(`dsh-orcana-linux/native-evidence: invalid ledgerMaxEntries ${JSON.stringify(maxEntries)} — expected a positive integer`)
  }
  const legacy = legacyHardeningFields(config)
  if (legacy.length > 0) throw new LegacyHardeningConfigMovedError(legacy)
}

/**
 * Observe DSH's public tool/shell result seams without changing policy, argv,
 * lifecycle, execution identity, result objects, or process handles.
 */
export function apply(ctx: Context, config: NativeEvidenceConfig = {}): void {
  validateNativeEvidenceConfig(config)
  const shell = ctx.shell as unknown as PatchableShell
  if (shell === undefined) {
    throw new Error('dsh-orcana-linux/native-evidence: ctx.shell is not registered yet — load this plugin after the shell executor')
  }
  const raw = (shell as unknown as Record<symbol, ShellExecutor>)[symbols.original] as PatchableShell
  if (raw[OBSERVER_PATCH_STATE]) throw new DuplicateNativeEvidenceError()

  // Event observation does not require the ToolRuntime service to be mounted:
  // normal DSH tool calls emit `tools/execute` and receive exact correlation;
  // direct programmatic shell calls remain valid evidence with no correlation.
  installNativeToolCorrelation(ctx)

  const maxEntries = config.ledgerMaxEntries ?? DEFAULT_NATIVE_EVIDENCE_LEDGER_MAX_ENTRIES
  let state = raw[EVIDENCE_LEDGER_STATE] as NativeEvidenceLedgerState | undefined
  if (state === undefined) {
    state = createLedgerState(maxEntries)
    raw[EVIDENCE_LEDGER_STATE] = state
  } else {
    resizeLedgerState(state, maxEntries)
  }
  new NativeExecutionEvidenceService(ctx, state)

  const originalRun = raw.run
  const originalStart = raw.start
  let active = true

  const wrappedRun: ShellExecutor['run'] = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
    if (!active) return await originalRun.call(raw, spec)
    const start = executionStartSnapshot(spec)
    try {
      const result = await originalRun.call(raw, spec)
      pushRecord(state, completedForegroundRecord(start, result, Date.now()))
      return result
    } catch (error) {
      pushRecord(state, rejectedRecord('foreground', start, error, Date.now()))
      throw error
    }
  }

  const wrappedStart: ShellExecutor['start'] = (spec: ShellExecSpec): ShellProcess => {
    if (!active) return originalStart.call(raw, spec)
    const start = executionStartSnapshot(spec)
    let process: ShellProcess
    try {
      process = originalStart.call(raw, spec)
    } catch (error) {
      pushRecord(state, rejectedRecord('background', start, error, Date.now()))
      throw error
    }
    state.pendingBackground += 1
    void process.done.then(() => {
      pushRecord(state, completedBackgroundRecord(start, process, Date.now()))
    }).catch((error: unknown) => {
      pushRecord(state, rejectedRecord('background', start, error, Date.now()))
    }).finally(() => {
      state.pendingBackground = Math.max(0, state.pendingBackground - 1)
    })
    return process
  }

  raw.run = wrappedRun
  raw.start = wrappedStart
  const patchState: ObserverPatchState = {
    owner: Symbol('dsh-orcana-native-evidence'),
    originalRun,
    wrappedRun,
    originalStart,
    wrappedStart,
  }
  raw[OBSERVER_PATCH_STATE] = patchState

  ctx.effect(() => () => {
    active = false
    if (raw[OBSERVER_PATCH_STATE] !== patchState) return
    raw[OBSERVER_PATCH_STATE] = undefined
    if (raw.run === wrappedRun) raw.run = originalRun
    if (raw.start === wrappedStart) raw.start = originalStart
    ctx.logger?.info('[dsh-orcana-linux] native evidence observer disposed')
  })
}

apply.Config = Config
apply.inject = ['shell']

export default apply
