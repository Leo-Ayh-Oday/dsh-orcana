/**
 * @leooday/dsh-orcana-linux — confined-execution hardening for DSH (Linux edition).
 *
 * Hardens executions that traverse DSH's official `ctx.sandbox` seam (no fork
 * required). cordis 4.0.1 refuses service replacement across fibers, so the
 * plugin patches the resolved `ctx.sandbox` provider instance's `confine`
 * method instead of replacing the service. The patch is lifecycle-correct:
 * the original `confine` is captured at mount, restored exactly at dispose,
 * and a second live instance against the same provider fails loud instead of
 * silently ignoring its configuration.
 *
 * Hardening layers (all over the base runner's own argv):
 *
 * - `resourceLimits` — a `prlimit` argv prefix on Linux (`--as` RLIMIT_AS
 *   ADDRESS-SPACE approximation, NOT a cgroup memory cap; `--nproc`
 *   PER-UID live-task cap, NOT per-cell). `cpuQuotaUs` needs cgroup v2
 *   authority and is out of this package's scope: it degrades, and under the
 *   default `required` enforcement it fails closed.
 * - `network: 'none'` — deny egress: `--unshare-net` injected into a bwrap
 *   argv (fresh network namespace, no routes), `(deny network*)` appended to
 *   a Seatbelt profile. Runners that cannot express egress denial degrade,
 *   and under the default `required` enforcement the confinement fails
 *   closed (`HARDENING_UNAVAILABLE`) rather than running unenforced.
 *
 * Limits come from the plugin config (deployment-level defaults), overridden
 * PER CALL: a caller may attach `resourceLimits` / `network` to the sandbox
 * policy object it passes to `confine` (e.g. a bash spec's `sandboxPolicy`
 * override). Every confinement is recorded in a bounded audit ledger exposed
 * as `ctx.hardening` (layers applied, structured degradations, request
 * facts, failure records).
 *
 * SCOPE: this package hardens the confined sandbox seam only. DSH's
 * `danger-full-access` mode bypasses `ctx.sandbox.confine` entirely
 * (`SandboxBashExecutor` runs `super.run()`), so executions under that mode
 * are OUTSIDE this package's enforcement authority (`ctx.hardening.scope`).
 *
 * This is the compatibility/hardening layer — NOT the full Orcana Execution
 * Fabric (cgroup v2 authority, pidfd ownership, execd, `ctx.subprocess` /
 * `ctx.codeRuntime` interception are future work, see DEFERRED-01..06).
 * @module @leooday/dsh-orcana-linux
 */

import { spawnSync } from 'node:child_process'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConfinedArgv, ConfinedSandboxMode, SandboxEnforcement, SandboxPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'

/** Resource limits the plugin can enforce at argv level. */
export interface ResourceLimits {
  /**
   * RLIMIT_AS bytes (`prlimit --as`) — an ADDRESS-SPACE approximation, not a
   * cgroup physical-memory cap. Do not present it as "N MB RAM".
   */
  memoryBytes?: number
  /**
   * RLIMIT_NPROC live-task cap (`prlimit --nproc`) — PER-UID process
   * accounting (caps every process of the calling user), not a per-cell PID
   * authority.
   */
  pidsMax?: number
  /**
   * cgroup v2 cpu quota per 100 ms period — needs cgroup v2 authority, out of
   * this package's scope; always degrades, and fails closed under `required`.
   */
  cpuQuotaUs?: number
}

/** Whether an un-enforceable requested layer stops the confinement. */
export type EnforcementMode = 'required' | 'best-effort'

/**
 * Per-layer degradation policy. `required` (the default) fails the
 * confinement closed with {@link HardeningUnavailableError} when the host
 * cannot express the requested layer; `best-effort` records the degradation
 * and continues. Requesting no layer never fails.
 */
export interface DegradationPolicy {
  resourceLimits?: EnforcementMode
  network?: EnforcementMode
}

/** Plugin config: deployment-level hardening applied to every confinement. */
export interface HardeningConfig {
  resourceLimits?: ResourceLimits
  network?: 'inherit' | 'none'
  /** Default `required` for both layers — un-enforceable requests fail closed. */
  degradationPolicy?: DegradationPolicy
  /** Bounded-ledger window size (default 1024; older records drop). */
  ledgerMaxEntries?: number
  /** Test hook / deployment pin: host capabilities instead of probing at mount. */
  capabilities?: HostCapabilities
}

/** Host facts probed ONCE per plugin mount (never per confinement). */
export interface HostCapabilities {
  platform: NodeJS.Platform
  /** Whether a usable `prlimit` binary exists on this host. */
  prlimit: boolean
}

/**
 * The per-call hardening carrier: callers may attach these fields to the
 * sandbox policy object passed to `confine` (they ride the official
 * SandboxPolicy untouched — official types simply do not declare them).
 */
export interface HardeningCarrier {
  resourceLimits?: ResourceLimits
  network?: 'inherit' | 'none'
}

/** A structured, machine-readable degradation fact. */
export interface HardeningDegradation {
  layer: 'memory' | 'pids' | 'cpu' | 'network'
  /** Human-readable reason the requested layer cannot be enforced. */
  reason: string
  /** The mechanism that would have been used (`prlimit`, `cgroup-v2`, …). */
  mechanism?: string
}

/** What was requested for one confinement. */
export interface HardeningRequest {
  resourceLimits?: ResourceLimits
  network?: 'inherit' | 'none'
}

/** One confined execution's hardening facts, for the audit ledger. */
export interface HardeningRecord {
  /** epoch ms of the confinement. */
  at: number
  /** The sandbox mode the execution ran under. */
  policyMode: ConfinedSandboxMode
  /** The resolved workspace root from the policy. */
  workspaceRoot: string
  /** What the caller requested (per-call wins over deployment config). */
  requested: HardeningRequest
  /** Layers actually applied, e.g. ['prlimit', 'network-none']. */
  applied: readonly string[]
  /** Requested layers this host could not provide (structured). */
  degraded: readonly HardeningDegradation[]
  /** The inner runner decided by the ORIGINAL argv head (e.g. `bwrap`). */
  baseRunner: string
  /** argv[0] of the final confined invocation (e.g. `prlimit` when prefixed). */
  finalArgv0: string
  /** The provider's file-effect enforcement completeness for this wrap. */
  enforcement: SandboxEnforcement
  /** Present only when the confinement failed closed (HARDENING_UNAVAILABLE). */
  failed?: string
}

/** The result of applying the hardening layers to one confined argv. */
export interface HardenedArgv {
  argv: string[]
  layers: readonly string[]
  degraded: readonly HardeningDegradation[]
}

/** Stable error code: a requested hardening layer could not be enforced. */
export const HARDENING_UNAVAILABLE = 'HARDENING_UNAVAILABLE'

/** Stable error code: a second live hardening instance against one provider. */
export const DUPLICATE_HARDENING_INSTANCE = 'DUPLICATE_HARDENING_INSTANCE'

/**
 * Thrown (fail-closed) when a REQUIRED hardening layer cannot be enforced on
 * this host. Distinct from the DSH `SandboxUnavailableError` (file-effect
 * confinement missing): this error is about the hardening layers. Carries the
 * FULL set of violating degradations so consumers and the audit ledger can
 * act on every un-enforceable layer, not just the first.
 */
export class HardeningUnavailableError extends Error {
  code: typeof HARDENING_UNAVAILABLE = HARDENING_UNAVAILABLE
  constructor(
    /** The first violating layer (primary blame). */
    readonly layer: HardeningDegradation['layer'],
    readonly mechanism: string | undefined,
    reason: string,
    /** EVERY required-but-unenforceable degradation, in violation order. */
    readonly degradations: readonly HardeningDegradation[],
  ) {
    super(`hardening unavailable: ${layer} (${mechanism ?? 'no mechanism'}) — ${reason}`)
    this.name = 'HardeningUnavailableError'
  }
}

/** Thrown at mount when another live dsh-orcana-linux instance owns the provider. */
export class DuplicateHardeningError extends Error {
  code: typeof DUPLICATE_HARDENING_INSTANCE = DUPLICATE_HARDENING_INSTANCE
  constructor() {
    super('a dsh-orcana-linux instance already owns this sandbox provider — dispose it before mounting another')
    this.name = 'DuplicateHardeningError'
  }
}

export const Config: z<HardeningConfig> = z.object({
  resourceLimits: z.object({
    memoryBytes: z.number().min(0),
    pidsMax: z.number().min(0),
    cpuQuotaUs: z.number().min(0),
  }),
  network: z.union(['inherit', 'none'] as const),
  degradationPolicy: z.object({
    resourceLimits: z.union(['required', 'best-effort'] as const),
    network: z.union(['required', 'best-effort'] as const),
  }),
  ledgerMaxEntries: z.number().min(1),
  // Test hook / deployment pin — accepted structurally (z.any keeps the
  // HostCapabilities shape out of the schema's own platform string typing).
  capabilities: z.any(),
})

/**
 * Validate a parsed hardening config strictly. schemastery's object schema is
 * LENIENT (it strips invalid properties instead of throwing), so a typo like
 * `network: 'None'` would silently drop the field and degrade to inherit —
 * the exact fail-open a fail-closed hardening layer must not allow. Called
 * from {@link apply} so misconfiguration fails loud at mount.
 */
export function validateConfig(config: HardeningConfig): void {
  const { network, degradationPolicy, resourceLimits, ledgerMaxEntries } = config
  if (network !== undefined && network !== 'inherit' && network !== 'none') {
    throw new Error(`dsh-orcana-linux: invalid network value ${JSON.stringify(network)} — expected 'inherit' | 'none'`)
  }
  if (degradationPolicy !== undefined) {
    const { resourceLimits: rm, network: nm } = degradationPolicy
    if (rm !== undefined && rm !== 'required' && rm !== 'best-effort') {
      throw new Error(`dsh-orcana-linux: invalid degradationPolicy.resourceLimits ${JSON.stringify(rm)} — expected 'required' | 'best-effort'`)
    }
    if (nm !== undefined && nm !== 'required' && nm !== 'best-effort') {
      throw new Error(`dsh-orcana-linux: invalid degradationPolicy.network ${JSON.stringify(nm)} — expected 'required' | 'best-effort'`)
    }
  }
  if (resourceLimits !== undefined) {
    const { memoryBytes, pidsMax, cpuQuotaUs } = resourceLimits
    for (const [name, value] of [['memoryBytes', memoryBytes], ['pidsMax', pidsMax], ['cpuQuotaUs', cpuQuotaUs]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`dsh-orcana-linux: invalid resourceLimits.${name} ${JSON.stringify(value)} — expected a non-negative finite number`)
      }
    }
  }
  if (ledgerMaxEntries !== undefined && (!Number.isInteger(ledgerMaxEntries) || ledgerMaxEntries < 1)) {
    throw new Error(`dsh-orcana-linux: invalid ledgerMaxEntries ${JSON.stringify(ledgerMaxEntries)} — expected a positive integer`)
  }
}

export const DEFAULT_LEDGER_MAX_ENTRIES = 1024

/** The default degradation policy: un-enforceable requests fail closed. */
export const DEFAULT_DEGRADATION_POLICY: Record<'resourceLimits' | 'network', EnforcementMode> = Object.freeze({
  resourceLimits: 'required',
  network: 'required',
})

/**
 * The effective hardening for one confinement: the policy-carried per-call
 * values win, the plugin config is the deployment-level fallback. Degradation
 * policy and ledger size stay deployment-level (not per-call carrier fields).
 */
export function effectiveConfig(config: HardeningConfig, policy: SandboxPolicy): HardeningConfig {
  const carrier = policy as unknown as HardeningCarrier
  const effective: HardeningConfig = {
    ...(config.degradationPolicy !== undefined ? { degradationPolicy: config.degradationPolicy } : {}),
    ...(config.ledgerMaxEntries !== undefined ? { ledgerMaxEntries: config.ledgerMaxEntries } : {}),
    ...(carrier.resourceLimits !== undefined || config.resourceLimits !== undefined
      ? { resourceLimits: carrier.resourceLimits ?? config.resourceLimits }
      : {}),
    ...(carrier.network !== undefined || config.network !== undefined
      ? { network: carrier.network ?? config.network }
      : {}),
  }
  return effective
}

/**
 * Probe host capabilities ONCE per plugin mount (never per confinement).
 * Injectable spawn for tests. The returned object is frozen.
 */
export function probeHostCapabilities(spawn: typeof spawnSync = spawnSync): HostCapabilities {
  const probe = spawn('prlimit', ['--version'], { timeout: 2_000, stdio: 'ignore' })
  const capabilities: HostCapabilities = {
    platform: process.platform,
    prlimit: probe.status === 0,
  }
  return Object.freeze(capabilities)
}

/**
 * The prlimit argv prefix for the enforce-able limits, or null when unusable.
 * Pure: consults the probed capabilities, never the host.
 */
export function prlimitPrefix(limits: ResourceLimits, capabilities: HostCapabilities): string[] | null {
  if (limits.memoryBytes === undefined && limits.pidsMax === undefined) return null
  if (!capabilities.prlimit) return null
  const args: string[] = []
  if (limits.memoryBytes !== undefined) args.push('--as=' + limits.memoryBytes)
  if (limits.pidsMax !== undefined) args.push('--nproc=' + limits.pidsMax)
  return ['prlimit', ...args]
}

/** Insert an extra bwrap flag before the `--` separator (append when absent). */
export function insertBeforeBwrapDash(argv: string[], flag: string): string[] {
  const dash = argv.indexOf('--')
  if (dash === -1) return [...argv, flag]
  return [...argv.slice(0, dash), flag, ...argv.slice(dash)]
}

/** Append a denial form to a Seatbelt profile string (`-p <profile>`). */
export function appendSeatbeltDeny(argv: string[], deny: string): string[] {
  const p = argv.indexOf('-p')
  if (p === -1 || p + 1 >= argv.length) return argv
  const profile = argv[p + 1]
  if (typeof profile !== 'string' || profile.length === 0) return argv
  const next = [...argv]
  next[p + 1] = profile + ' ' + deny
  return next
}

/** The degradation-policy key for one degradation layer. */
export function policyKeyForLayer(layer: HardeningDegradation['layer']): 'resourceLimits' | 'network' {
  return layer === 'network' ? 'network' : 'resourceLimits'
}

/** The configured enforcement mode for one degradation layer (default `required`). */
export function degradationMode(config: HardeningConfig, layer: HardeningDegradation['layer']): EnforcementMode {
  const key = policyKeyForLayer(layer)
  return config.degradationPolicy?.[key] ?? DEFAULT_DEGRADATION_POLICY[key]
}

/** Apply the hardening layers to a confined argv; never throws. */
export function applyHardening(base: ConfinedArgv, config: HardeningConfig, capabilities: HostCapabilities): HardenedArgv {
  const layers: string[] = []
  const degraded: HardeningDegradation[] = []
  let argv = base.argv
  // The inner runner is decided by the ORIGINAL argv head, before any
  // hardening prefix (prlimit) lands in front of it.
  const runner = base.argv[0]
  const limits = config.resourceLimits
  if (limits !== undefined) {
    const prefix = prlimitPrefix(limits, capabilities)
    if (prefix !== null) {
      argv = [...prefix, ...argv]
      layers.push('prlimit')
    } else {
      if (limits.memoryBytes !== undefined) {
        degraded.push({ layer: 'memory', mechanism: 'prlimit', reason: 'prlimit binary unavailable or unusable on this host' })
      }
      if (limits.pidsMax !== undefined) {
        degraded.push({ layer: 'pids', mechanism: 'prlimit', reason: 'prlimit binary unavailable or unusable on this host' })
      }
    }
    if (limits.cpuQuotaUs !== undefined) {
      degraded.push({ layer: 'cpu', mechanism: 'cgroup-v2', reason: 'cpuQuotaUs needs cgroup v2 authority, out of this package scope' })
    }
  }
  if (config.network === 'none') {
    if (runner === 'bwrap') {
      argv = insertBeforeBwrapDash(argv, '--unshare-net')
      layers.push('network-none')
    } else if (runner === 'sandbox-exec') {
      argv = appendSeatbeltDeny(argv, '(deny network*)')
      layers.push('network-none')
    } else {
      degraded.push({ layer: 'network', mechanism: 'runner-capability', reason: `runner '${runner}' cannot express egress denial` })
    }
  }
  return { argv, layers, degraded }
}

/**
 * Apply the hardening layers and enforce the degradation policy: when a
 * REQUESTED layer degraded and its policy is `required`, throw
 * {@link HardeningUnavailableError} (fail closed) instead of returning an
 * unenforced argv.
 */
export function enforceHardening(base: ConfinedArgv, config: HardeningConfig, capabilities: HostCapabilities): HardenedArgv {
  const hardened = applyHardening(base, config, capabilities)
  const violations = hardened.degraded.filter((d) => degradationMode(config, d.layer) === 'required')
  if (violations.length > 0) {
    const detail = violations.map((v) => `${v.layer}: ${v.reason}`).join('; ')
    throw new HardeningUnavailableError(violations[0]!.layer, violations[0]!.mechanism, detail, violations)
  }
  return hardened
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hardening: HardeningService
  }
}

/**
 * The hardening audit ledger service (`ctx.hardening`). Bounded: keeps the
 * newest `maxEntries` records and counts what dropped, so the ledger cannot
 * grow without bound. Exposes the enforcement scope explicitly.
 */
export class HardeningService extends Service {
  private readonly records: HardeningRecord[] = []
  private dropped = 0
  private total = 0
  constructor(ctx: Context, private readonly maxEntries: number = DEFAULT_LEDGER_MAX_ENTRIES) {
    super(ctx, 'hardening')
  }
  /** Append one confinement record (drops the oldest when full). */
  record(entry: HardeningRecord): void {
    this.total += 1
    if (this.records.length >= this.maxEntries) {
      this.records.shift()
      this.dropped += 1
    }
    this.records.push(entry)
  }
  /** A snapshot of the newest `maxEntries` records (copy — callers cannot mutate the buffer). */
  get ledger(): readonly HardeningRecord[] {
    return [...this.records]
  }
  /** Records dropped from the window because the ledger is bounded. */
  get droppedCount(): number {
    return this.dropped
  }
  /** Every record ever appended, including dropped ones. */
  get totalRecorded(): number {
    return this.total
  }
  /** The execution surface this package enforces — confined modes only. */
  get scope(): { confinedModes: true; dangerFullAccess: false } {
    return { confinedModes: true, dangerFullAccess: false }
  }
}

/** Patch ownership metadata for one provider instance. */
interface PatchState {
  /** Identity of the owning plugin instance (also used by dispose restore). */
  owner: symbol
  /** The exact original confine (as resolved through cordis), restored at dispose. */
  original: SandboxProvider['confine']
  /** The wrapper installed at mount. */
  wrapped: SandboxProvider['confine']
}

/**
 * Live patch ownership: one active dsh-orcana-linux instance per provider.
 * Stored as a symbol-keyed property on the provider TARGET (cordis resolves
 * `ctx.sandbox` to a traceable proxy; symbol reads/writes forward straight to
 * the underlying service instance, so ownership is visible across every
 * proxy view of the same provider). `Symbol.for` keeps duplicate package
 * copies (failed dedupe) sharing one ownership registry instead of silently
 * stacking.
 */
const PATCHED_STATE = Symbol.for('orcana.dsh-orcana-linux.patchState')
type Patchable = SandboxProvider & Record<symbol, unknown> & { confine: SandboxProvider['confine'] }

/** Function plugin: patch the resolved sandbox provider with hardening layers. */
export function apply(ctx: Context, config: HardeningConfig = {}) {
  validateConfig(config)
  const inner = ctx.sandbox as unknown as Patchable
  if (inner === undefined) {
    throw new Error('dsh-orcana-linux: ctx.sandbox is not registered yet — load this plugin after the sandbox provider')
  }
  if (inner[PATCHED_STATE]) {
    // Two live instances with different configs must not silently overlap:
    // fail loud, the owner disposes (restoring the original) before remount.
    throw new DuplicateHardeningError()
  }
  const capabilities = config.capabilities ?? probeHostCapabilities()
  const ledger = new HardeningService(ctx, config.ledgerMaxEntries ?? DEFAULT_LEDGER_MAX_ENTRIES)
  // `ctx.sandbox` is a cordis traceable proxy: method reads come back wrapped
  // (fresh shadow wrappers per read). The TARGET (`symbols.original`) carries
  // the real `confine`; capture it from there so dispose can restore the exact
  // reference, and call it with the target as `this` (the provider's own
  // implementation state). Reads/writes of the PATCHED_STATE symbol and the
  // `confine` property land on the target, so all proxy views agree.
  const raw = (inner as unknown as Record<symbol, SandboxProvider>)[symbols.original]
  const original = raw.confine
  const wrapped: SandboxProvider['confine'] = (argv: readonly string[], policy: SandboxPolicy): ConfinedArgv => {
    const base = original.call(raw, argv, policy)
    const effective = effectiveConfig(config, policy)
    let hardened: HardenedArgv
    try {
      hardened = enforceHardening(base, effective, capabilities)
    } catch (error) {
      if (error instanceof HardeningUnavailableError) {
        // Fail-closed attempts are still audited with their FULL structured
        // degradation facts (not just the message string).
        ledger.record({
          at: Date.now(),
          policyMode: policy.mode,
          workspaceRoot: policy.workspaceRoot,
          requested: effective,
          applied: [],
          degraded: error.degradations,
          baseRunner: base.argv[0] ?? '',
          finalArgv0: base.argv[0] ?? '',
          enforcement: base.enforcement,
          failed: error.message,
        })
      }
      throw error
    }
    ledger.record({
      at: Date.now(),
      policyMode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      requested: effective,
      applied: hardened.layers,
      degraded: hardened.degraded,
      baseRunner: base.argv[0] ?? '',
      finalArgv0: hardened.argv[0] ?? '',
      enforcement: base.enforcement,
    })
    return { ...base, argv: hardened.argv }
  }
  inner.confine = wrapped
  const state: PatchState = { owner: Symbol('dsh-orcana-linux'), original, wrapped }
  inner[PATCHED_STATE] = state
  // cordis effect: the returned disposer runs when this fiber unloads.
  // DisposableList clears in REVERSE registration order (and unload awaits
  // them concurrently), so a wrapper registered later is disposed before
  // this one restores — the restore guard below keeps that order safe.
  ctx.effect(() => () => {
    restorePatch(inner, state)
    ctx.logger?.info('[dsh-orcana-linux] hardening disposed')
  })
}

// Wire the validated schema so cordis validates plugin config at load time;
// validateConfig() re-checks strictness because schemastery object schemas
// are lenient (they strip invalid properties rather than throwing).
apply.Config = Config

/**
 * Restore the exact original confine, guarded so other patches are never
 * clobbered. Comparison happens on the provider TARGET (via cordis's
 * `symbols.original` escape hatch) because every proxy view wraps method
 * reads in fresh shadow wrappers.
 */
function restorePatch(inner: Patchable, state: PatchState): void {
  if (inner[PATCHED_STATE] !== state) return
  inner[PATCHED_STATE] = undefined
  const raw = (inner as unknown as Record<symbol, SandboxProvider>)[symbols.original]
  if (raw.confine !== state.wrapped) {
    // Another plugin wrapped on top of ours after mount; restoring would
    // clobber its chain. Leave the provider alone (ownership was released).
    return
  }
  raw.confine = state.original
}

// Resolve the harness's sandbox before this plugin runs (cordis inject).
apply.inject = ['sandbox']

export default apply
