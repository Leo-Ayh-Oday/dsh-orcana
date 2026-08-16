import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import {
  ShellExecutor,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import { describe, expect, it } from 'vitest'
import nativeEvidence, {
  LEGACY_HARDENING_CONFIG_MOVED,
  LegacyHardeningConfigMovedError,
} from '../src/native-evidence.ts'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class ControlledShell extends ShellExecutor {
  runGate: Promise<void> | undefined
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
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async run(_spec: ShellExecSpec): Promise<ShellRunResult> {
    await this.runGate
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 60_000,
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: { mode: 'workspace-write', denied: false },
    }
  }

  start(_spec: ShellExecSpec): ShellProcess {
    if (this.nextProcess === undefined) throw new Error('process not configured')
    return this.nextProcess
  }
}

function fakeProcess(done: Promise<void>): ShellProcess {
  return {
    status: 'running',
    exitCode: null,
    signal: null,
    done,
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => true,
  }
}

describe('native-evidence migration safety', () => {
  it.each([
    [{ network: 'none' as const }, ['network']],
    [{ resourceLimits: { memoryBytes: 1024 } }, ['resourceLimits']],
    [{ degradationPolicy: { network: 'required' as const } }, ['degradationPolicy']],
    [{ capabilities: { platform: 'linux' } }, ['capabilities']],
  ])('fails closed instead of silently stripping legacy hardening config %#', async (legacy, fields) => {
    const ctx = new Context()
    new ControlledShell(ctx)

    let error: unknown
    try {
      await ctx.plugin(nativeEvidence, legacy)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(LegacyHardeningConfigMovedError)
    expect((error as LegacyHardeningConfigMovedError).code).toBe(LEGACY_HARDENING_CONFIG_MOVED)
    expect((error as LegacyHardeningConfigMovedError).fields).toEqual(fields)
    expect(String(error)).toContain('sandbox-policy')
    await ctx.fiber.dispose()
  })

  it('accepts evidence-only config without inventing enforcement authority', async () => {
    const ctx = new Context()
    new ControlledShell(ctx)
    await ctx.plugin(nativeEvidence, { ledgerMaxEntries: 7 })
    expect(ctx.orcanaLinuxEvidence.scope).toEqual({
      enforcementOwner: 'dsh',
      observationSeam: 'shell',
      mutatesExecution: false,
      dangerFullAccessObserved: true,
    })
    expect(ctx.orcanaLinuxEvidence.ledger).toEqual([])
    await ctx.fiber.dispose()
  })
})

describe('native-evidence temporal integrity', () => {
  it('freezes command/workdir/policy at execution start, not after the body settles', async () => {
    const ctx = new Context()
    const shell = new ControlledShell(ctx)
    const gate = deferred<void>()
    shell.runGate = gate.promise
    await ctx.plugin(nativeEvidence, {})

    const originalCommand = 'echo original'
    const spec = ctx.shell.resolve({
      command: originalCommand,
      workdir: '/repo/original',
      sandboxPolicy: {
        mode: 'workspace-write',
        workspaceRoot: '/repo/original',
        network: 'none',
        resourceLimits: { memoryBytes: 1024 },
      },
    })

    const running = ctx.shell.run(spec)
    spec.command = 'echo mutated-after-start'
    spec.workdir = '/repo/mutated'
    if (spec.sandboxPolicy !== undefined) {
      spec.sandboxPolicy.workspaceRoot = '/repo/mutated'
      spec.sandboxPolicy.network = 'inherit'
      spec.sandboxPolicy.resourceLimits = { memoryBytes: 999999 }
    }
    gate.resolve()
    await running

    const record = ctx.orcanaLinuxEvidence.ledger[0]!
    expect(record.commandHash).toBe(createHash('sha256').update(originalCommand).digest('hex'))
    expect(record.workdir).toBe('/repo/original')
    expect(record.policy).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/repo/original',
      network: 'none',
      resourceLimits: { memoryBytes: 1024 },
    })
    await ctx.fiber.dispose()
  })

  it('keeps an in-flight background record across observer dispose and remount', async () => {
    const ctx = new Context()
    const shell = new ControlledShell(ctx)
    const done = deferred<void>()
    const proc = fakeProcess(done.promise)
    shell.nextProcess = proc

    const first = await ctx.plugin(nativeEvidence, { ledgerMaxEntries: 8 })
    const spec = ctx.shell.resolve({
      command: 'sleep 1',
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: '/repo' },
    })
    expect(ctx.shell.start(spec)).toBe(proc)
    expect(ctx.orcanaLinuxEvidence.pendingBackground).toBe(1)

    await first.dispose()
    const second = await ctx.plugin(nativeEvidence, { ledgerMaxEntries: 8 })
    expect(ctx.orcanaLinuxEvidence.pendingBackground).toBe(1)

    proc.status = 'completed'
    proc.exitCode = 0
    proc.sandbox = { mode: 'workspace-write', denied: false }
    done.resolve()
    await done.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(ctx.orcanaLinuxEvidence.pendingBackground).toBe(0)
    expect(ctx.orcanaLinuxEvidence.ledger.at(-1)).toMatchObject({
      kind: 'background',
      outcome: 'completed',
      exitCode: 0,
      evidenceKind: 'sandbox-facts',
    })

    await second.dispose()
    await ctx.fiber.dispose()
  })
})
