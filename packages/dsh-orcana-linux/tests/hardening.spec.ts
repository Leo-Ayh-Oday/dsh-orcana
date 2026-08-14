import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { describe, expect, it } from 'vitest'
import { apply as hardening, HardeningService } from '../src/index.ts'

const RO = { mode: 'read-only', workspaceRoot: '/' } as const

describe('@orcana/dsh-hardening', () => {
  it('patches the resolved sandbox provider and serves the ledger', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(hardening, { resourceLimits: { memoryBytes: 512 * 1024 * 1024 }, network: 'none' })
    expect(ctx.hardening).toBeInstanceOf(HardeningService)
    // confine still works through the patched provider
    const confined = ctx.sandbox.confine(['true'], { ...RO })
    expect(confined.argv[0]).toBe('prlimit')
    expect(confined.argv).toContain('--unshare-net')
    await ctx.fiber.dispose()
  })

  it('applies prlimit --as and bwrap --unshare-net to the confined argv', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(hardening, { resourceLimits: { memoryBytes: 512 * 1024 * 1024 }, network: 'none' })
    const confined = ctx.sandbox.confine(['true'], { ...RO })
    expect(confined.argv[0]).toBe('prlimit')
    expect(confined.argv[1]).toBe('--as=536870912')
    expect(confined.argv).toContain('bwrap')
    expect(confined.argv).toContain('--unshare-net')
    expect(confined.argv.indexOf('--unshare-net')).toBeLessThan(confined.argv.indexOf('--'))
    // the wrap still confines for real: RLIMIT_AS is visible inside
    const limited = ctx.sandbox.confine(['bash', '-c', 'ulimit -v'], { ...RO })
    const spawn = spawnSync(limited.argv[0] as string, limited.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
    expect(spawn.status).toBe(0)
    expect(spawn.stdout.trim()).toBe('524288')
    // egress-none: an empty route table inside the fresh network namespace
    const egress = ctx.sandbox.confine(['bash', '-c', 'cat /proc/net/route'], { ...RO })
    const spawned = spawnSync(egress.argv[0] as string, egress.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
    expect(spawned.status).toBe(0)
    const rows = spawned.stdout.split('\n').filter(line => line.trim().length > 0 && !line.trim().startsWith('Iface'))
    expect(rows).toEqual([])
    // the ledger recorded both confinements
    expect(ctx.hardening.ledger.length).toBeGreaterThanOrEqual(2)
    expect(ctx.hardening.ledger[0].layers).toContain('prlimit')
    expect(ctx.hardening.ledger[0].layers).toContain('network-none')
    await ctx.fiber.dispose()
  })

  it('degrades visibly when a layer cannot be expressed', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(hardening, { resourceLimits: { cpuQuotaUs: 50000 } })
    const confined = ctx.sandbox.confine(['true'], { ...RO })
    // cpuQuotaUs has no rlimit equivalent: recorded degraded, argv untouched
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
    // exactly one prlimit prefix (the first config wins)
    expect(confined.argv.filter(a => a === 'prlimit').length).toBe(1)
    expect(confined.argv[1]).toBe('--as=536870912')
    await ctx.fiber.dispose()
  })
})

