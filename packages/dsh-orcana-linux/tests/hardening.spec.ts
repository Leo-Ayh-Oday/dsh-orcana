import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { describe, expect, it } from 'vitest'
import {
  appendSeatbeltDeny,
  apply as hardening,
  applyHardening,
  effectiveConfig,
  HardeningService,
  insertBeforeBwrapDash,
  type HardeningCarrier,
} from '../src/index.ts'

const RO = { mode: 'read-only', workspaceRoot: '/' } as const

const prlimitUsable = spawnSync('prlimit', ['--version'], { timeout: 2_000, stdio: 'ignore' }).status === 0
const bwrapUsable = spawnSync(
  'bwrap',
  ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--', 'true'],
  { timeout: 5_000, stdio: 'ignore' },
).status === 0

function baseArgv(argv: string[]) {
  return { argv, enforcement: 'full' as const, denialSignatures: [] as string[], runnerFailureRules: [] }
}

describe('applyHardening (pure)', () => {
  it('injects --unshare-net into a bwrap argv before the -- separator', () => {
    const out = applyHardening(baseArgv(['bwrap', '--ro-bind', '/', '/', '--', 'true']), { network: 'none' })
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
    const out = applyHardening(baseArgv(['bwrap', '--', 'true']), { resourceLimits: { memoryBytes: 512 * 1024 * 1024, pidsMax: 16 } })
    if (!prlimitUsable) {
      expect(out.degraded.join(' ')).toContain('resource-limits')
      return
    }
    expect(out.argv.slice(0, 3)).toEqual(['prlimit', '--as=536870912', '--nproc=16'])
    expect(out.layers).toContain('prlimit')
  })

  it('degrades cpuQuotaUs visibly and keeps argv untouched', () => {
    const out = applyHardening(baseArgv(['bwrap', '--', 'true']), { resourceLimits: { cpuQuotaUs: 50_000 } })
    expect(out.argv[0]).not.toBe('prlimit')
    expect(out.degraded.join(' ')).toContain('cpu-quota-us')
  })

  it('reports degradation when network none cannot be expressed by the runner', () => {
    const out = applyHardening(baseArgv(['some-runner', '--', 'true']), { network: 'none' })
    expect(out.degraded.join(' ')).toContain('network-none')
  })

  it('insertBeforeBwrapDash appends when no -- separator exists', () => {
    expect(insertBeforeBwrapDash(['bwrap', '--ro-bind', '/', '/'], '--unshare-net')).toEqual([
      'bwrap', '--ro-bind', '/', '/', '--unshare-net',
    ])
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
      expect(ctx.hardening.ledger[0].degraded.join(' ')).toContain('resource-limits')
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

  it('degrades visibly when a layer cannot be expressed', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(hardening, { resourceLimits: { cpuQuotaUs: 50_000 } })
    const confined = ctx.sandbox.confine(['true'], { ...RO })
    expect(confined.argv[0]).not.toBe('prlimit')
    expect(ctx.hardening.ledger[0].degraded.join(' ')).toContain('cpu-quota-us')
    await ctx.fiber.dispose()
  })

  it('is idempotent: applying twice does not double-wrap', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(hardening, { resourceLimits: { memoryBytes: 512 * 1024 * 1024 } })
    await ctx.plugin(hardening, { resourceLimits: { memoryBytes: 256 * 1024 * 1024 } })
    const confined = ctx.sandbox.confine(['true'], { ...RO })
    if (prlimitUsable) {
      expect(confined.argv.filter(a => a === 'prlimit').length).toBe(1)
      expect(confined.argv[1]).toBe('--as=536870912')
    }
    await ctx.fiber.dispose()
  })
})

