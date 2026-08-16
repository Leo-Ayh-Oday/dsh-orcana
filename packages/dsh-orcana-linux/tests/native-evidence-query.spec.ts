import { Context } from '@deepseek-ai/cordis'
import {
  ShellExecutor,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import { describe, expect, it } from 'vitest'
import nativeEvidence from '../src/native-evidence.ts'
import {
  runWithNativeToolCorrelation,
  type NativeToolCorrelation,
} from '../src/native-tool-correlation.ts'

class EvidenceShell extends ShellExecutor {
  constructor(ctx: Context) {
    super(ctx)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/repo',
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async run(_spec: ShellExecSpec): Promise<ShellRunResult> {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 60_000,
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: {
        mode: 'workspace-write',
        denied: false,
        enforcement: 'full',
        receipt: {
          layers: ['cgroup-v2', 'network-none'],
          degraded: [],
          limitsMechanism: 'cgroup-v2',
          cgroupPath: '/sys/fs/cgroup/dsh/test',
          memoryPeakBytes: 4096,
          cpuUsageUs: 123,
          pidsPeak: 2,
          cleanupVerified: true,
          live: { current: 0, peak: 1, total: 1 },
        },
      },
    }
  }

  start(_spec: ShellExecSpec): ShellProcess {
    throw new Error('not used in this test')
  }
}

function correlation(
  sessionId: string,
  callId: string,
  rootCallId: string,
  toolName = 'bash',
): NativeToolCorrelation {
  return { sessionId, callId, rootCallId, toolName }
}

async function runCorrelated(
  ctx: Context,
  identity: NativeToolCorrelation,
  command: string,
): Promise<ShellRunResult> {
  const spec = ctx.shell.resolve({
    command,
    workdir: '/repo',
    sandboxPolicy: {
      mode: 'workspace-write',
      workspaceRoot: '/repo',
      network: 'none',
      resourceLimits: { memoryBytes: 1024 },
    },
  })
  return await runWithNativeToolCorrelation(identity, () => ctx.shell.run(spec))
}

describe('native evidence causal queries', () => {
  it('queries by session/call/root/tool without assuming call ids are globally unique', async () => {
    const ctx = new Context()
    new EvidenceShell(ctx)
    await ctx.plugin(nativeEvidence, {})

    await runCorrelated(ctx, correlation('s1', 'c1', 'r1'), 'echo one')
    await runCorrelated(ctx, correlation('s1', 'c2', 'r1'), 'echo two')
    await runCorrelated(ctx, correlation('s2', 'c1', 'r2'), 'echo three')
    await ctx.shell.run(ctx.shell.resolve({ command: 'echo direct', workdir: '/repo' }))

    expect(ctx.orcanaLinuxEvidence.ledger).toHaveLength(4)
    expect(ctx.orcanaLinuxEvidence.find({ sessionId: 's1' })).toHaveLength(2)
    expect(ctx.orcanaLinuxEvidence.find({ rootCallId: 'r1' })).toHaveLength(2)
    expect(ctx.orcanaLinuxEvidence.find({ callId: 'c1' })).toHaveLength(2)
    expect(ctx.orcanaLinuxEvidence.find({ sessionId: 's1', callId: 'c1' })).toHaveLength(1)
    expect(ctx.orcanaLinuxEvidence.find({ sessionId: 's1', rootCallId: 'r1', toolName: 'bash' })).toHaveLength(2)
    expect(ctx.orcanaLinuxEvidence.find({ sessionId: 'missing' })).toEqual([])
    expect(ctx.orcanaLinuxEvidence.latest({ sessionId: 's1', rootCallId: 'r1' })?.correlation?.callId).toBe('c2')
    expect(() => ctx.orcanaLinuxEvidence.find({})).toThrow(/at least one causal field/)
    expect(() => ctx.orcanaLinuxEvidence.latest({})).toThrow(/at least one causal field/)

    await ctx.fiber.dispose()
  })

  it('freezes the evidence window deeply while leaving the original DSH result mutable', async () => {
    const ctx = new Context()
    new EvidenceShell(ctx)
    await ctx.plugin(nativeEvidence, {})

    const identity = correlation('s1', 'c1', 'r1')
    const result = await runCorrelated(ctx, identity, 'echo immutable')
    const ledger = ctx.orcanaLinuxEvidence.ledger
    const record = ledger[0]!
    const receipt = record.sandbox?.receipt

    expect(Object.isFrozen(ledger)).toBe(true)
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.correlation)).toBe(true)
    expect(Object.isFrozen(record.policy)).toBe(true)
    expect(Object.isFrozen(record.policy?.resourceLimits)).toBe(true)
    expect(Object.isFrozen(record.sandbox)).toBe(true)
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt?.layers)).toBe(true)
    expect(Object.isFrozen(receipt?.degraded)).toBe(true)
    expect(Object.isFrozen(receipt?.live)).toBe(true)

    expect(() => { (record as { workdir: string }).workdir = '/tampered' }).toThrow(TypeError)
    expect(() => { (receipt?.layers as string[]).push('fake-layer') }).toThrow(TypeError)
    expect(ctx.orcanaLinuxEvidence.latest({ sessionId: 's1', callId: 'c1' })?.workdir).toBe('/repo')

    // Orcana froze only its detached snapshot. Downstream DSH consumers still
    // own the real result object and may mutate it without touching evidence.
    expect(Object.isFrozen(result)).toBe(false)
    expect(Object.isFrozen(result.sandbox?.receipt)).toBe(false)
    ;(result.sandbox?.receipt?.layers as string[]).push('caller-owned-change')
    expect(result.sandbox?.receipt?.layers).toContain('caller-owned-change')
    expect(ctx.orcanaLinuxEvidence.latest({ sessionId: 's1', callId: 'c1' })?.sandbox?.receipt?.layers)
      .not.toContain('caller-owned-change')

    await ctx.fiber.dispose()
  })
})
