/**
 * @orcana/dsh-orcana-linux — native hardening layers as a DSH plugin.
 *
 * Mounts on the OFFICIAL DSH sandbox contract (no fork required). cordis
 * 4.0.1 refuses service replacement across fibers (provide refuses a second
 * registration, reflect.set requires the registering fiber), so the plugin
 * patches the resolved `ctx.sandbox` provider instance's `confine` method
 * (idempotent, symbol-guarded) instead of replacing the service:
 *
 * - `resourceLimits` (memoryBytes / pidsMax / cpuQuotaUs) — a `prlimit`
 *   argv prefix on Linux (`--as` RLIMIT_AS memory approximation, `--nproc`
 *   PER-UID task cap). cpuQuotaUs has no rlimit equivalent and degrades
 *   visibly. No prlimit binary — honest degradation record, never silent.
 * - `network: 'none'` — deny egress: `--unshare-net` injected into a bwrap
 *   argv (fresh network namespace, no routes), `(deny network*)` appended
 *   to a Seatbelt profile. Runners that cannot express it are recorded
 *   degraded.
 *
 * Limits come from the plugin config (deployment-level defaults) and can be
 * overridden PER CALL: a caller may attach `resourceLimits` / `network` to
 * the sandbox policy object it passes to `confine` (e.g. a bash spec's
 * `sandboxPolicy` override) — the runtime object rides the official policy
 * untouched. Every confinement is recorded in an audit ledger exposed as
 * `ctx.hardening` (layers applied, degradations, mechanism).
 * @module @orcana/dsh-orcana-linux
 */

import { spawnSync } from 'node:child_process'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConfinedArgv, SandboxPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'

/** Resource limits the plugin can enforce at argv level. */
export interface ResourceLimits {
  /** RLIMIT_AS bytes (prlimit --as; an address-space approximation). */
  memoryBytes?: number
  /** RLIMIT_NPROC live-task cap (prlimit --nproc; PER-UID). */
  pidsMax?: number
  /** cpu.max quota per 100 ms period — needs cgroup v2; degrades visibly. */
  cpuQuotaUs?: number
}

/** Plugin config: deployment-level hardening applied to every confinement. */
export interface HardeningConfig {
  resourceLimits?: ResourceLimits
  network?: 'inherit' | 'none'
}

export const Config: z<HardeningConfig> = z.object({
  resourceLimits: z.object({
    memoryBytes: z.number().min(0),
    pidsMax: z.number().min(0),
    cpuQuotaUs: z.number().min(0),
  }),
  network: z.union(['inherit', 'none'] as const),
})

/**
 * The per-call hardening carrier: callers may attach these fields to the
 * sandbox policy object passed to `confine` (they ride the official
 * SandboxPolicy untouched — official types simply do not declare them).
 */
export interface HardeningCarrier {
  resourceLimits?: ResourceLimits
  network?: 'inherit' | 'none'
}

/** One confined execution's hardening facts, for the audit ledger. */
export interface HardeningRecord {
  /** Layers actually applied, e.g. ['prlimit', 'network-none']. */
  layers: readonly string[]
  /** Requested layers this host could not provide. */
  degraded: readonly string[]
  /** argv[0] of the final confined invocation. */
  argv0: string
  /** epoch ms of the confinement. */
  at: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hardening: HardeningService
  }
}

/** The hardening audit ledger service (`ctx.hardening`). */
export class HardeningService extends Service {
  private readonly records: HardeningRecord[] = []
  constructor(ctx: Context) {
    super(ctx, 'hardening')
  }
  /** Append one confinement record. */
  record(entry: HardeningRecord): void {
    this.records.push(entry)
  }
  /** Every confinement record so far. */
  get ledger(): readonly HardeningRecord[] {
    return this.records
  }
}

/** The result of applying the hardening layers to one confined argv. */
export interface HardenedArgv {
  argv: string[]
  layers: readonly string[]
  degraded: readonly string[]
}

/**
 * The effective hardening for one confinement: the policy-carried per-call
 * values win, the plugin config is the deployment-level fallback.
 */
export function effectiveConfig(config: HardeningConfig, policy: SandboxPolicy): HardeningConfig {
  const carrier = policy as unknown as HardeningCarrier
  return {
    ...(carrier.resourceLimits !== undefined || config.resourceLimits !== undefined
      ? { resourceLimits: carrier.resourceLimits ?? config.resourceLimits }
      : {}),
    ...(carrier.network !== undefined || config.network !== undefined
      ? { network: carrier.network ?? config.network }
      : {}),
  }
}

/** Apply the hardening layers to a confined argv; never throws. */
export function applyHardening(base: ConfinedArgv, config: HardeningConfig): HardenedArgv {
  const layers: string[] = []
  const degraded: string[] = []
  let argv = base.argv
  // The inner runner is decided by the ORIGINAL argv head, before any
  // hardening prefix (prlimit) lands in front of it.
  const runner = base.argv[0]
  const limits = config.resourceLimits
  if (limits !== undefined) {
    const prefix = prlimitPrefix(limits)
    if (prefix !== null) {
      argv = [...prefix, ...argv]
      layers.push('prlimit')
    } else if (limits.memoryBytes !== undefined || limits.pidsMax !== undefined) {
      degraded.push('resource-limits (no prlimit on this host)')
    }
    if (limits.cpuQuotaUs !== undefined) degraded.push('cpu-quota-us (needs cgroup v2)')
  }
  if (config.network === 'none') {
    if (runner === 'bwrap') {
      argv = insertBeforeBwrapDash(argv, '--unshare-net')
      layers.push('network-none')
    } else if (runner === 'sandbox-exec') {
      argv = appendSeatbeltDeny(argv, '(deny network*)')
      layers.push('network-none')
    } else {
      degraded.push('network-none (runner cannot express egress denial)')
    }
  }
  return { argv, layers, degraded }
}

/** The prlimit argv prefix for the enforce-able limits, or null when unusable. */
export function prlimitPrefix(limits: ResourceLimits): string[] | null {
  if (limits.memoryBytes === undefined && limits.pidsMax === undefined) return null
  const probe = spawnSync('prlimit', ['--version'], { timeout: 2_000, stdio: 'ignore' })
  if (probe.status !== 0) return null
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

/** Idempotence guard placed on a patched provider instance. */
const PATCHED = Symbol('orcana.dsh-orcana-linux.patched')

/** Function plugin: patch the resolved sandbox provider with hardening layers. */
export function apply(ctx: Context, config: HardeningConfig = {}) {
  const inner = ctx.sandbox as SandboxProvider & { [PATCHED]?: boolean }
  if (inner === undefined) {
    throw new Error('dsh-orcana-linux: ctx.sandbox is not registered yet — load this plugin after the sandbox provider')
  }
  if (inner[PATCHED]) return
  const ledger = new HardeningService(ctx)
  const original = inner.confine.bind(inner)
  Object.defineProperty(inner, PATCHED, { value: true, enumerable: false })
  inner.confine = (argv: string[], policy: SandboxPolicy): ConfinedArgv => {
    const base = original(argv, policy)
    const hardened = applyHardening(base, effectiveConfig(config, policy))
    ledger.record({ layers: hardened.layers, degraded: hardened.degraded, argv0: hardened.argv[0] ?? '', at: Date.now() })
    return { ...base, argv: hardened.argv }
  }
}

// Resolve the harness's sandbox before this plugin runs (cordis inject).
apply.inject = ['sandbox']

export default apply

