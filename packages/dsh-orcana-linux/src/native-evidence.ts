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
 * The deprecated fields intentionally remain in the schema so an upgraded
 * profile cannot have an old enforcement request silently stripped by
 * schemastery. Their presence throws {@link LegacyHardeningConfigMovedError}.
 */
export interface NativeEvidenceConfig {
  /** Bounded final-execution evidence window. Older rows are dropped. */
  ledgerMaxEntries?: number
  /** @deprecated Move to DSH's `sandbox-policy.resourceLimits`. */
  resourceLimits?: LegacyHardeningResourceLimits
  /** @deprecated Move to DSH's `sandbox-policy.network`. */
  network?: 'inherit' | 'none'
  /** @deprecated No native-evidence equivalent; DSH reports degradation in SandboxReceipt. */
  degradationPolicy?: LegacyHardeningDegradationPolicy
  /** @deprecated Legacy test/deployment capability pin; native-evidence never probes enforcement. */
  capabilities?: unknown
}

export const DEFAULT_NATIVE_EVIDENCE_LEDGER_MAX_ENTRIES = 1024

export const Config: z<NativeEvidenceConfig> = z.object({
  ledgerMaxEntries: z.number().min(1),
  // These legacy rows are deliberately accepted by the schema and rejected
  // by validateNativeEvidenceConfig(). If omitted here, schemastery may strip
  // them before apply(), silently weakening an upgraded profile.
  resourceLimits: z.object({
    memoryBytes: z.number().min(0),
    cpuQuotaUs: z.number().min(0),
    pidsMax: z.number().min(0),
  }),
  network: z.union(['inherit', 'none'] as const),
  degradationPolicy: z.object({
    resourceLimits: z.union(['required', 'best-effort'] as const),
    network: z.union(['required', 'best-effort'] as const),
  }),
  capabilities: z.any(),
})

/** Stable code for a second live observer wrapping the same shell provider. */
export const DUPLICATE_NATIVE_EVIDENCE_INSTANCE = 'DUPLICATE_NATIVE_EVIDENCE_INSTANCE'

export class DuplicateNativeEvidenceError extends Error {
  code: typeof DUPLICATE_NATIVE_EVIDENCE_INSTANCE = DUPLICATE_NATIVE_EVIDENCE_INSTANCE
  constructor() {
    super('a dsh-orcana native-evidence observer already owns this shell provider — dispose it before mounting another')
    this.name = 'DuplicateNativeEvidenceError'
  }
}

/** Stable migration error: an old Orcana enforcement config reached the evidence-only adapter. */
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
 * Final execution evidence derived only from DSH's public shell/sandbox result
 * contracts. Raw command text is intentionally absent; only a stable SHA-256
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

interface NativeExecutionStartSnapshot {
  startedAt: number
  commandHash: string
  commandBytes: number
  workdir: string
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

function pushRecord(state: NativeEvidenceLedgerState, record: NativeExecutionRecord): void {
  state.total += 1
  if (state.records.length >= state.maxEntries) {
    state.records.shift()
    state.dropped += 1
  }
  state.records.push(record)
}

/** DSH-native evidence exposed to Orcana/governance consumers. */
export class NativeExecutionEvidenceService extends Service {
  constructor(ctx: Context, private readonly state: NativeEvidenceLedgerState) {
    super(ctx, 'orcanaLinuxEvidence')
  }

  /** Snapshot copy; callers cannot mutate the bounded internal window. */
  get ledger(): readonly NativeExecutionRecord[] {
    return [...this.state.records]
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

  /** Authority declaration: DSH enforces, Orcana observes and governs evidence. */
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
  return {
    startedAt: Date.now(),
    ...commandFingerprint(spec.command),
    workdir: spec.workdir,
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

/** Live observer patch metadata stored on the raw shell provider. */
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
 * Observe DSH's public shell result seam without changing policy, argv,
 * lifecycle, result objects, or process handles. DSH remains the sole native
 * enforcement owner; Orcana consumes the facts DSH actually reports.
 */
export function apply(ctx: Context, config: NativeEvidenceConfig = {}): void {
  validateNativeEvidenceConfig(config)
  const shell = ctx.shell as unknown as PatchableShell
  if (shell === undefined) {
    throw new Error('dsh-orcana-linux/native-evidence: ctx.shell is not registered yet — load this plugin after the shell executor')
  }
  const raw = (shell as unknown as Record<symbol, ShellExecutor>)[symbols.original] as PatchableShell
  if (raw[OBSERVER_PATCH_STATE]) throw new DuplicateNativeEvidenceError()

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
    const observing = active
    if (!observing) return await originalRun.call(raw, spec)
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
    const observing = active
    if (!observing) return originalStart.call(raw, spec)
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
      // A process that started while this observer was active still belongs to
      // this evidence stream even if the observer fiber reloaded before exit.
      pushRecord(state, completedBackgroundRecord(start, process, Date.now()))
    }).catch((error: unknown) => {
      // DSH's ShellProcess.done contract says it never rejects. Keep the
      // observer total if a third-party shell provider violates that contract.
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
    // Restore only methods still owned by this observer. A later wrapper is
    // never clobbered during disposal; any stale observer wrapper becomes a
    // pure pass-through because `active` is now false.
    if (raw.run === wrappedRun) raw.run = originalRun
    if (raw.start === wrappedStart) raw.start = originalStart
    ctx.logger?.info('[dsh-orcana-linux] native evidence observer disposed')
  })
}

apply.Config = Config
apply.inject = ['shell']

export default apply
