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

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const RECEIPT = {
  layers: ['network-none'],
  degraded: [],
  limitsMechanism: 'none' as const,
  cleanupVerified: true,
}

function correlation(id: string): NativeToolCorrelation {
  return {
    sessionId: `session-${id}`,
    callId: `call-${id}`,
    rootCallId: `root-${id}`,
    toolName: 'bash',
  }
}

class CorrelationShell extends ShellExecutor {
  nextProcess: ShellProcess | undefined

  constructor(ctx: Context) {
    super(ctx)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/repo',
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024,
      ...(request.sandboxPolicy !== undefined ? { sandboxPolicy: request.sandboxPolicy } : {}),
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    if (spec.command === 'slow-a') await wait(25)
    else if (spec.command === 'fast-b') await wait(5)
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'ok\n', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: {
        mode: spec.sandboxPolicy?.mode ?? 'danger-full-access',
        denied: false,
        ...(spec.sandboxPolicy === undefined ? {} : { enforcement: 'full' as const, receipt: RECEIPT }),
      },
    }
  }

  start(_spec: ShellExecSpec): ShellProcess {
    if (this.nextProcess === undefined) throw new Error('process not configured')
    return this.nextProcess
  }
}

function policy() {
  return { mode: 'workspace-write' as const, workspaceRoot: '/repo', network: 'none' as const }
}

describe('native evidence causal correlation', () => {
  it('keeps concurrent Agent/tool receipts isolated on one runtime-global ledger', async () => {
    const ctx = new Context()
    new CorrelationShell(ctx)
    await ctx.plugin(nativeEvidence, {})

    await Promise.all([
      runWithNativeToolCorrelation(correlation('a'), async () => {
        await ctx.shell.run(ctx.shell.resolve({ command: 'slow-a', sandboxPolicy: policy() }))
      }),
      runWithNativeToolCorrelation(correlation('b'), async () => {
        await ctx.shell.run(ctx.shell.resolve({ command: 'fast-b', sandboxPolicy: policy() }))
      }),
    ])

    expect(ctx.orcanaLinuxEvidence.ledger).toHaveLength(2)
    expect(ctx.orcanaLinuxEvidence.ledger.map(row => row.correlation)).toContainEqual(correlation('a'))
    expect(ctx.orcanaLinuxEvidence.ledger.map(row => row.correlation)).toContainEqual(correlation('b'))
    expect(ctx.orcanaLinuxEvidence.ledger.every(row => row.evidenceKind === 'native-receipt')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('records a direct programmatic shell call honestly as uncorrelated', async () => {
    const ctx = new Context()
    new CorrelationShell(ctx)
    await ctx.plugin(nativeEvidence, {})

    await ctx.shell.run(ctx.shell.resolve({ command: 'direct', sandboxPolicy: policy() }))
    expect(ctx.orcanaLinuxEvidence.ledger[0]?.correlation).toBeUndefined()
    expect(ctx.orcanaLinuxEvidence.ledger[0]?.evidenceKind).toBe('native-receipt')
    await ctx.fiber.dispose()
  })

  it('captures background correlation at start and keeps it after the async tool scope ends', async () => {
    const ctx = new Context()
    const shell = new CorrelationShell(ctx)
    const done = deferred()
    const process: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: done.promise,
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => true,
    }
    shell.nextProcess = process
    await ctx.plugin(nativeEvidence, {})

    const background = correlation('background')
    const returned = await runWithNativeToolCorrelation(background, async () => {
      return ctx.shell.start(ctx.shell.resolve({ command: 'background', sandboxPolicy: policy() }))
    })
    expect(returned).toBe(process)
    expect(ctx.orcanaLinuxEvidence.totalRecorded).toBe(0)
    expect(ctx.orcanaLinuxEvidence.pendingBackground).toBe(1)

    process.status = 'completed'
    process.exitCode = 0
    process.sandbox = {
      mode: 'workspace-write',
      denied: false,
      enforcement: 'full',
      receipt: RECEIPT,
    }
    done.resolve()
    await done.promise
    await wait(0)

    expect(ctx.orcanaLinuxEvidence.pendingBackground).toBe(0)
    expect(ctx.orcanaLinuxEvidence.ledger[0]).toMatchObject({
      kind: 'background',
      correlation: background,
      evidenceKind: 'native-receipt',
      exitCode: 0,
    })
    await ctx.fiber.dispose()
  })
})
