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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

class ReloadShell extends ShellExecutor {
  process: ShellProcess | undefined
  constructor(ctx: Context) { super(ctx) }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/repo',
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024,
      ...(request.sandboxPolicy !== undefined ? { sandboxPolicy: request.sandboxPolicy } : {}),
    }
  }

  async run(_spec: ShellExecSpec): Promise<ShellRunResult> {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 60_000,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    }
  }

  start(_spec: ShellExecSpec): ShellProcess {
    if (this.process === undefined) throw new Error('process missing')
    return this.process
  }
}

describe('native evidence observer reload', () => {
  it('keeps a pending background execution visible and records its final rc.6 sandbox facts after remount', async () => {
    const ctx = new Context()
    const shell = new ReloadShell(ctx)
    const done = deferred()
    shell.process = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: done.promise,
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => true,
    }

    const fiberA = await ctx.plugin(nativeEvidence, { ledgerMaxEntries: 8 })
    const spec = ctx.shell.resolve({
      command: 'long-running-build',
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: '/repo' },
    })
    ctx.shell.start(spec)
    expect(ctx.orcanaLinuxEvidence.pendingBackground).toBe(1)

    await fiberA.dispose()
    const fiberB = await ctx.plugin(nativeEvidence, { ledgerMaxEntries: 8 })
    expect(ctx.orcanaLinuxEvidence.pendingBackground).toBe(1)

    shell.process.status = 'completed'
    shell.process.exitCode = 0
    shell.process.sandbox = {
      mode: 'workspace-write',
      denied: false,
      enforcement: 'full',
    }
    done.resolve()
    await done.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(ctx.orcanaLinuxEvidence.pendingBackground).toBe(0)
    expect(ctx.orcanaLinuxEvidence.totalRecorded).toBe(1)
    expect(ctx.orcanaLinuxEvidence.ledger[0]).toMatchObject({
      kind: 'background',
      outcome: 'completed',
      evidenceKind: 'sandbox-facts',
      sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full' },
    })

    await fiberB.dispose()
    await ctx.fiber.dispose()
  })
})
