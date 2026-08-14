import { spawnSync } from 'node:child_process'
import { Context, symbols } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, vi } from 'vitest'
import {
  appendSeatbeltDeny,
  apply as hardening,
  applyHardening,
  DEFAULT_DEGRADATION_POLICY,
  degradationMode,
  DuplicateHardeningError,
  effectiveConfig,
  enforceHardening,
  HardeningService,
  HardeningUnavailableError,
  insertBeforeBwrapDash,
  policyKeyForLayer,
  probeHostCapabilities,
  validateConfig,
  type HardeningCarrier,
  type HostCapabilities,
} from '../src/index.ts'

const RO = { mode: 'read-only', workspaceRoot: '/' } as const

const prlimitUsable = spawnSync('prlimit', ['--version'], { timeout: 2_000, stdio: 'ignore' }).status === 0
const bwrapUsable = spawnSync(
  'bwrap',
  ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--', 'true'],
  { timeout: 5_000, stdio: 'ignore' },
).status === 0

const CAPS: HostCapabilities = { platform: 'linux', prlimit: prlimitUsable }
const NO_PRLIMIT: HostCapabilities = { platform: 'linux', prlimit: false }

function baseArgv(argv: string[]) {
  return { argv, enforcement: 'full' as const, denialSignatures: [] as string[], runnerFailureRules: [] }
}

/** The provider TARGET behind cordis's traceable proxy (method reads wrap otherwise). */
function rawProvider(provider: unknown): LocalSandboxProvider {
  return (provider as unknown as Record<symbol, LocalSandboxProvider>)[symbols.original]
}

describe('applyHardening (pure)', () => {
  it('injects --unshare-net into a bwrap argv before the -- separator', () => {
    const out = applyHardening(baseArgv(['bwrap', '--ro-bind', '/', '/', '--', 'true']), { network: 'none' }, CAPS)
    expect(out.argv).toEqual(['bwrap', '--ro-bind', '/', '/', '--unshare-net', '--', 'true'])
    expect(out.layers).toEqual(['network-none'])
    expect(out.degraded).toEqual([])
  })

  it('appends (deny network*) to a seatbelt profile string', () => {
    const profile = '(version 1) (allow default)'
    const out = appendSeatbeltDeny(['sandbox-exec', '-p', profile, '--', 'true'], '(deny network*)')
    expect(out[2]).toBe(profile + ' (deny network*)')
  })

  it('prepends the prlimit argv prefix when limits are requested and prlimit exists', () => {
    const out = applyHardening(baseArgv(['bwrap', '--', 'true']), { resourceLimits: { memoryBytes: 512 * 1024 * 1024, pidsMax: 16 } }, CAPS)
    if (!prlimitUsable) {
      expect(out.degraded.map((d) => d.layer)).toContain('memory')
      return
    }
    expect(out.argv.slice(0, 3)).toEqual(['prlimit', '--as=536870912', '--nproc=16'])
    expect(out.layers).toContain('prlimit')
  })

  it('never probes the host from the pure apply path', () => {
    // prlimitPrefix consults ONLY the passed capabilities — no spawnSync.
    const out = applyHardening(baseArgv(['bwrap', '--', 'true']), { resourceLimits: { memoryBytes: 1024 } }, NO_PRLIMIT)
    expect(out.argv[0]).not.toBe('prlimit')
    expect(out.degraded.map((d) => d.layer)).toContain('memory')
  })

  it('degrades cpuQuotaUs as a structured unsupported layer and keeps argv untouched', () => {
    const out = applyHardening(baseArgv(['bwrap', '--', 'true']), { resourceLimits: { cpuQuotaUs: 50_000 } }, CAPS)
    expect(out.argv[0]).not.toBe('prlimit')
    expect(out.degraded).toEqual([
      expect.objectContaining({ layer: 'cpu', mechanism: 'cgroup-v2' }),
    ])
  })

  it('reports a structured degradation when network none cannot be expressed by the runner', () => {
    const out = applyHardening(baseArgv(['some-runner', '--', 'true']), { network: 'none' }, CAPS)
    expect(out.degraded).toEqual([
      expect.objectContaining({ layer: 'network', mechanism: 'runner-capability' }),
    ])
  })

  it('insertBeforeBwrapDash appends when no -- separator exists', () => {
    expect(insertBeforeBwrapDash(['bwrap', '--ro-bind', '/', '/'], '--unshare-net')).toEqual([
      'bwrap', '--ro-bind', '/', '/', '--unshare-net',
    ])
  })
})

describe('degradation policy', () => {
  it('defaults both layers to required (fail closed)', () => {
    expect(DEFAULT_DEGRADATION_POLICY).toEqual({ resourceLimits: 'required', network: 'required' })
    expect(degradationMode({}, 'network')).toBe('required')
    expect(degradationMode({}, 'memory')).toBe('required')
    expect(policyKeyForLayer('network')).toBe('network')
    expect(policyKeyForLayer('memory')).toBe('resourceLimits')
  })

  it('required + unsupported network runner fails closed with a typed error', () => {
    expect(() => enforceHardening(baseArgv(['some-runner', '--', 'true']), { network: 'none' }, CAPS))
      .toThrow(HardeningUnavailableError)
  })

  it('required + no prlimit on host fails closed for resource limits', () => {
    expect(() => enforceHardening(baseArgv(['bwrap', '--', 'true']), { resourceLimits: { memoryBytes: 1024 } }, NO_PRLIMIT))
      .toThrow(HardeningUnavailableError)
  })

  it('required + cpuQuotaUs always fails closed (unsupported layer)', () => {
    expect(() => enforceHardening(baseArgv(['bwrap', '--', 'true']), { resourceLimits: { cpuQuotaUs: 50_000 } }, CAPS))
      .toThrow(HardeningUnavailableError)
  })

  it('explicit best-effort degrades and continues instead of failing', () => {
    const out = enforceHardening(
      baseArgv(['some-runner', '--', 'true']),
      { network: 'none', degradationPolicy: { network: 'best-effort' } },
      CAPS,
    )
    expect(out.degraded.some((d) => d.layer === 'network')).toBe(true)
  })

  it('best-effort resource limits degrade and continue', () => {
    const out = enforceHardening(
      baseArgv(['bwrap', '--', 'true']),
      { resourceLimits: { memoryBytes: 1024, cpuQuotaUs: 50_000 }, degradationPolicy: { resourceLimits: 'best-effort' } },
      NO_PRLIMIT,
    )
    expect(out.degraded.map((d) => d.layer)).toEqual(['memory', 'cpu'])
    expect(out.argv[0]).toBe('bwrap')
  })

  it('HardeningUnavailableError carries a stable code and layer', () => {
    try {
      enforceHardening(baseArgv(['some-runner', '--', 'true']), { network: 'none' }, CAPS)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(HardeningUnavailableError)
      expect((error as HardeningUnavailableError).code).toBe('HARDENING_UNAVAILABLE')
      expect((error as HardeningUnavailableError).layer).toBe('network')
    }
  })
})

describe('effectiveConfig', () => {
  it('per-call policy fields win over the plugin config', () => {
    const config = { resourceLimits: { memoryBytes: 512 * 1024 * 1024 }, network: 'inherit' as const }
    const policy = { ...RO, resourceLimits: { memoryBytes: 1024 * 1024 }, network: 'none' as const }
    const effective = effectiveConfig(config, policy as SandboxPolicy)
    expect(effective.resourceLimits?.memoryBytes).toBe(1024 * 1024)
    expect(effective.network).toBe('none')
  })

  it('falls back to the plugin config when the policy carries nothing', () => {
    const config = { resourceLimits: { memoryBytes: 512 * 1024 * 1024 } }
    const effective = effectiveConfig(config, { ...RO })
    expect(effective.resourceLimits?.memoryBytes).toBe(512 * 1024 * 1024)
    expect(effective.network).toBeUndefined()
  })

  it('degradation policy and ledger size stay deployment-level', () => {
    const config = { degradationPolicy: { network: 'best-effort' as const }, ledgerMaxEntries: 7 }
    const policy = { ...RO, network: 'none' as const } as SandboxPolicy
    const effective = effectiveConfig(config, policy)
    expect(effective.degradationPolicy?.network).toBe('best-effort')
    expect(effective.ledgerMaxEntries).toBe(7)
  })
})

describe('probeHostCapabilities', () => {
  it('probes the host exactly once per call, via the injectable spawn', () => {
    const spawn = vi.fn(() => ({ status: 0 })) as unknown as typeof spawnSync
    const caps = probeHostCapabilities(spawn)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('prlimit', ['--version'], expect.anything())
    expect(caps.prlimit).toBe(true)
    expect(Object.isFrozen(caps)).toBe(true)
  })

  it('reports prlimit unusable when the probe spawn fails', () => {
    const spawn = vi.fn(() => ({ status: 1 })) as unknown as typeof spawnSync
    expect(probeHostCapabilities(spawn).prlimit).toBe(false)
  })
})

describe('HardeningService ledger', () => {
  it('is bounded: drops the oldest beyond maxEntries, exposes dropped/total', () => {
    const ctx = new Context()
    const ledger = new HardeningService(ctx, 3)
    for (let i = 0; i < 10; i += 1) {
      ledger.record({
        at: i,
        policyMode: 'read-only',
        workspaceRoot: '/',
        requested: {},
        applied: [],
        degraded: [],
        baseRunner: 'bwrap',
        finalArgv0: 'bwrap',
        enforcement: 'full',
      })
    }
    expect(ledger.ledger.length).toBe(3)
    expect(ledger.totalRecorded).toBe(10)
    expect(ledger.droppedCount).toBe(7)
    expect(ledger.ledger.map((r) => r.at)).toEqual([7, 8, 9])
  })

  it('declares its enforcement scope honestly', () => {
    const ctx = new Context()
    const ledger = new HardeningService(ctx)
    expect(ledger.scope).toEqual({ confinedModes: true, dangerFullAccess: false })
  })
})

describe('validateConfig', () => {
  it('accepts a valid config', () => {
    expect(() => validateConfig({ network: 'none', degradationPolicy: { network: 'best-effort' } })).not.toThrow()
    expect(() => validateConfig({})).not.toThrow()
  })

  it('rejects an invalid network value (would silently fail open otherwise)', () => {
    expect(() => validateConfig({ network: 'None' as never })).toThrow(/invalid network value/)
    expect(() => validateConfig({ network: 'disabled' as never })).toThrow(/invalid network value/)
  })

  it('rejects invalid degradation policy values', () => {
    expect(() => validateConfig({ degradationPolicy: { network: 'always' as never } })).toThrow(/degradationPolicy\.network/)
    expect(() => validateConfig({ degradationPolicy: { resourceLimits: 'maybe' as never } })).toThrow(/degradationPolicy\.resourceLimits/)
  })

  it('rejects negative / non-finite resource limits and non-positive ledger sizes', () => {
    expect(() => validateConfig({ resourceLimits: { memoryBytes: -1 } })).toThrow(/resourceLimits\.memoryBytes/)
    expect(() => validateConfig({ resourceLimits: { pidsMax: Number.NaN } })).toThrow(/resourceLimits\.pidsMax/)
    expect(() => validateConfig({ ledgerMaxEntries: 0 })).toThrow(/ledgerMaxEntries/)
  })

  it('fails loud at mount on misconfiguration', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    let error: unknown
    try {
      await ctx.plugin(hardening, { network: 'None' as never })
    } catch (caught) {
      error = caught
    }
    // cordis validates plugin config against apply.Config at load time.
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toMatch(/expected "inherit" \| "none"/)
    await ctx.fiber.dispose()
  })
})

describe.skipIf(!bwrapUsable)('lifecycle through the real provider', () => {
  it('mounts a wrapper, then dispose restores the EXACT original confine', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    const provider = ctx.sandbox
    const raw = rawProvider(provider)
    const original = raw.confine
    const fiber = await ctx.plugin(hardening, { network: 'none' })
    expect(ctx.hardening).toBeInstanceOf(HardeningService)
    expect(raw.confine).not.toBe(original)
    expect(provider.confine(['true'], { ...RO }).argv).toContain('--unshare-net')
    await fiber.dispose()
    expect(raw.confine).toBe(original)
    expect(provider.confine(['true'], { ...RO }).argv).not.toContain('--unshare-net')
    await ctx.fiber.dispose()
  })

  it('supports mount A → dispose → mount B with B\'s config active', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    const raw = rawProvider(ctx.sandbox)
    const original = raw.confine
    const fiberA = await ctx.plugin(hardening, { network: 'none' })
    const wrappedA = raw.confine
    await fiberA.dispose()
    expect(raw.confine).toBe(original)
    await ctx.plugin(hardening, { resourceLimits: { memoryBytes: 128 * 1024 * 1024 } })
    const confined = ctx.sandbox.confine(['true'], { ...RO })
    expect(confined.argv).not.toContain('--unshare-net')
    if (prlimitUsable) {
      expect(confined.argv[0]).toBe('prlimit')
      expect(confined.argv[1]).toBe('--as=134217728')
    }
    // After the A→B handoff exactly one patch layer remains on the target:
    // A's wrapper was restored (raw.confine === original), and B installed a
    // NEW wrapper (different from A's) that is currently active.
    expect(raw.confine).not.toBe(original)
    expect(raw.confine).not.toBe(wrappedA)
    await ctx.fiber.dispose()
  })

  it('fails loud with DUPLICATE_HARDENING_INSTANCE on a second active mount', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(hardening, { resourceLimits: { memoryBytes: 512 * 1024 * 1024 } })
    let error: unknown
    try {
      await ctx.plugin(hardening, { resourceLimits: { memoryBytes: 256 * 1024 * 1024 } })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DuplicateHardeningError)
    expect((error as DuplicateHardeningError).code).toBe('DUPLICATE_HARDENING_INSTANCE')
    // The first instance is untouched: its config still governs.
    const confined = ctx.sandbox.confine(['true'], { ...RO })
    if (prlimitUsable) {
      expect(confined.argv[0]).toBe('prlimit')
      expect(confined.argv[1]).toBe('--as=536870912')
      expect(confined.argv.filter((a) => a === 'prlimit').length).toBe(1)
    }
    await ctx.fiber.dispose()
  })

  it('probes once per instance: injected capabilities win, 100 confinements re-probe nothing', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    const injected: HostCapabilities = { platform: 'linux', prlimit: false }
    await ctx.plugin(hardening, { resourceLimits: { memoryBytes: 1024 }, capabilities: injected })
    for (let i = 0; i < 100; i += 1) {
      try {
        ctx.sandbox.confine(['true'], { ...RO })
      } catch {
        // required + injected prlimit:false fails closed — expected, still counts.
      }
    }
    // Every confinement was served from the injected facts; the ledger holds
    // the injected degradation (fail-closed records carry `failed`), and no
    // host probe ever overrode it.
    expect(ctx.hardening.totalRecorded).toBe(100)
    expect(ctx.hardening.ledger.every((r) => r.failed !== undefined || r.degraded.some((d) => d.layer === 'memory'))).toBe(true)
    expect(ctx.hardening.ledger.every((r) => r.requested.resourceLimits?.memoryBytes === 1024)).toBe(true)
    await ctx.fiber.dispose()
  })
})

describe.skipIf(!bwrapUsable)('integration through the real provider', () => {
  it('patches the sandbox provider and serves the ledger', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(hardening, { resourceLimits: { memoryBytes: 512 * 1024 * 1024 }, network: 'none' })
    expect(ctx.hardening).toBeInstanceOf(HardeningService)
    const confined = ctx.sandbox.confine(['true'], { ...RO })
    if (prlimitUsable) expect(confined.argv[0]).toBe('prlimit')
    expect(confined.argv).toContain('--unshare-net')
    await ctx.fiber.dispose()
  })

  it('applies per-call resourceLimits over the deployment config', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(hardening, { resourceLimits: { memoryBytes: 512 * 1024 * 1024 } })
    const policy = { ...RO, resourceLimits: { memoryBytes: 128 * 1024 * 1024 } } as SandboxPolicy & HardeningCarrier
    const confined = ctx.sandbox.confine(['true'], policy)
    if (prlimitUsable) {
      expect(confined.argv[1]).toBe('--as=134217728')
    } else {
      expect(ctx.hardening.ledger[0]?.degraded.some((d) => d.layer === 'memory')).toBe(true)
    }
    await ctx.fiber.dispose()
  })

  it('enforces for real: RLIMIT_AS visible inside, egress-none route table empty', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(hardening, { resourceLimits: { memoryBytes: 512 * 1024 * 1024 }, network: 'none' })
    if (prlimitUsable) {
      const limited = ctx.sandbox.confine(['bash', '-c', 'ulimit -v'], { ...RO })
      const spawn = spawnSync(limited.argv[0] as string, limited.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
      expect(spawn.status).toBe(0)
      expect(spawn.stdout.trim()).toBe('524288')
    }
    const egress = ctx.sandbox.confine(['bash', '-c', 'cat /proc/net/route'], { ...RO })
    const spawned = spawnSync(egress.argv[0] as string, egress.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
    expect(spawned.status).toBe(0)
    const rows = spawned.stdout.split('\n').filter(line => line.trim().length > 0 && !line.trim().startsWith('Iface'))
    expect(rows).toEqual([])
    expect(ctx.hardening.ledger.length).toBeGreaterThanOrEqual(2)
    await ctx.fiber.dispose()
  })

  it('degrades visibly when a layer cannot be expressed, under best-effort', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(hardening, {
      resourceLimits: { cpuQuotaUs: 50_000 },
      degradationPolicy: { resourceLimits: 'best-effort' },
    })
    const confined = ctx.sandbox.confine(['true'], { ...RO })
    expect(confined.argv[0]).not.toBe('prlimit')
    const record = ctx.hardening.ledger[0]!
    expect(record.degraded.some((d) => d.layer === 'cpu')).toBe(true)
    expect(record.requested.resourceLimits?.cpuQuotaUs).toBe(50_000)
    await ctx.fiber.dispose()
  })

  it('fails closed at confine time and audits the failure record', async () => {
    const ctx = new Context()
    // Assert a runner that cannot express egress denial, so the hardening
    // layer must fail closed instead of running unenforced.
    await ctx.plugin(LocalSandboxProvider, { runnerCommand: ['some-runner'], runnerFailureSignatures: ['boom'] })
    await ctx.plugin(hardening, { network: 'none', capabilities: { platform: 'linux', prlimit: false } })
    let error: unknown
    try {
      ctx.sandbox.confine(['true'], { ...RO })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(HardeningUnavailableError)
    expect((error as HardeningUnavailableError).degradations.length).toBeGreaterThan(0)
    expect((error as HardeningUnavailableError).degradations.some((d) => d.layer === 'network')).toBe(true)
    const record = ctx.hardening.ledger[0]!
    expect(record.failed).toContain('network')
    expect(record.requested.network).toBe('none')
    expect(record.applied).toEqual([])
    // Fail-closed records keep the FULL structured degradation facts.
    expect(record.degraded.some((d) => d.layer === 'network')).toBe(true)
    await ctx.fiber.dispose()
  })
})

describe.skipIf(!bwrapUsable)('integration through the real SandboxBashExecutor', () => {
  async function harness(ctx: Context) {
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only' })
    await ctx.plugin(SandboxBashExecutor, {})
    return ctx.shell as SandboxBashExecutor
  }

  it('per-call carrier rides request.sandboxPolicy through resolve → run → confine', async () => {
    const ctx = new Context()
    const shell = await harness(ctx)
    await ctx.plugin(hardening, { network: 'none' })
    const spec = shell.resolve({
      command: 'echo hardened',
      sandboxPolicy: { mode: 'read-only', workspaceRoot: '/', network: 'none' } as never,
    })
    const result = await shell.run(spec)
    expect(result.exitCode).toBe(0)
    const record = ctx.hardening.ledger.at(-1)!
    expect(record.requested.network).toBe('none')
    expect(record.applied).toContain('network-none')
    expect(record.policyMode).toBe('read-only')
    await ctx.fiber.dispose()
  })

  it('danger-full-access bypasses the confine seam: no ledger record, no hardening', async () => {
    const ctx = new Context()
    const shell = await harness(ctx)
    await ctx.plugin(hardening, { network: 'none' })
    const before = ctx.hardening.totalRecorded
    const spec = shell.resolve({
      command: 'echo open',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/' } as never,
    })
    const result = await shell.run(spec)
    expect(result.exitCode).toBe(0)
    // The full-access path runs super.run() directly — this package never saw it.
    expect(ctx.hardening.totalRecorded).toBe(before)
    await ctx.fiber.dispose()
  })
})
