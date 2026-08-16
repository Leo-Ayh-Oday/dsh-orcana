import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Context, symbols } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import {
  ShellExecutor,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'
import nativeEvidence, {
  DuplicateNativeEvidenceError,
  NativeExecutionEvidenceService,
  nativeEvidenceKind,
  snapshotNativePolicy,
  snapshotNativeReceipt,
  snapshotNativeSandbox,
} from '../src/native-evidence.ts'

const bwrapUsable = spawnSync(
  'bwrap',
  ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--', 'true'],
  { timeout: 5_000, stdio: 'ignore' },
).status === 0

const POLICY = {
  mode: 'workspace-write' as const,
  workspaceRoot: '/repo',
  resourceLimits: { memoryBytes: 64 * 1024 * 1024, cpuQuotaUs: 50_000, pidsMax: 16 },
  network: 'none' as const,
}

const RECEIPT = {
  layers: ['cgroup-v2', 'network-none'],
  degraded: [],
  limitsMechanism: 'cgroup-v2' as const,
  cgroupPath: '/sys/fs/cgroup/dsh/cell-test',
  memoryPeakBytes: 1024,
  cpuUsageUs: 2048,
  pidsPeak: 3,
  cleanupVerified: true,
  live: { current: 0, peak: 2, total: 7 },
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeShellExecutor extends ShellExecutor {
  runResult: ShellRunResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 60_000,
    stdout: { text: 'ok\n', truncated: false },
    stderr: { text: '', truncated: false },
    sandbox: {
      mode: 'workspace-write',
      denied: false,
      enforcement: 'full',
      receipt: RECEIPT,
    },
  }
  runError: unknown
  nextProcess: ShellProcess | undefined

  constructor(ctx: Context) {
    super(ctx)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/repo',
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024 * 1024,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async run(_spec: ShellExecSpec): Promise<ShellRunResult> {
    if (this.runError !== undefined) throw this.runError
    return this.runResult
  }

  start(_spec: ShellExecSpec): ShellProcess {
    if (this.runError !== undefined) throw this.runError
    if (this.nextProcess === undefined) throw new Error('fake process not configured')
    return this.nextProcess
  }
}

function rawShell(shell: unknown): FakeShellExecutor {
  return (shell as unknown as Record<symbol, FakeShellExecutor>)[symbols.original]
}

function fakeProcess(done: Promise<void>): ShellProcess {
  return {
    status: 'running',
    exitCode: null,
    signal: null,
    done,
    sandbox: undefined,
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => true,
  }
}

describe('native evidence pure snapshots', () => {
  it('copies DSH policy/receipt/sandbox facts without inventing enforcement', () => {
    expect(snapshotNativePolicy(POLICY)).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/repo',
      resourceLimits: POLICY.resourceLimits,
      network: 'none',
    })
    expect(snapshotNativeReceipt(RECEIPT)).toEqual(RECEIPT)
    expect(snapshotNativeSandbox({
      mode: 'workspace-write',
      denied: false,
      enforcement: 'full',
      receipt: RECEIPT,
    })).toEqual({
      mode: 'workspace-write',
      denied: false,
      enforcement: 'full',
      receipt: RECEIPT,
    })
    expect(nativeEvidenceKind({ mode: 'danger-full-access', denied: false })).toBe('sandbox-facts')
    expect(nativeEvidenceKind(undefined)).toBe('none')
  })
})

describe('native evidence shell observation', () => {
  it('preserves the exact foreground result object and stores only a command fingerprint', async () => {
    const ctx = new Context()
    const fake = new FakeShellExecutor(ctx)
    const raw = rawShell(ctx.shell)
    const originalRun = raw.run
    const originalStart = raw.start
    const fiber = await ctx.plugin(nativeEvidence, {})

    const secretCommand = 'curl -H "Authorization: Bearer super-secret-token" https://example.invalid'
    const spec = ctx.shell.resolve({ command: secretCommand, sandboxPolicy: POLICY })
    const result = await ctx.shell.run(spec)
    expect(result).toBe(fake.runResult)
    expect(ctx.orcanaLinuxEvidence).toBeInstanceOf(NativeExecutionEvidenceService)
    expect(ctx.orcanaLinuxEvidence.scope).toEqual({
      enforcementOwner: 'dsh',
      observationSeam: 'shell',
      mutatesExecution: false,
      dangerFullAccessObserved: true,
    })

    const record = ctx.orcanaLinuxEvidence.ledger[0]!
    expect(record.evidenceKind).toBe('native-receipt')
    expect(record.sandbox?.receipt).toEqual(RECEIPT)
    expect(record.policy).toEqual(snapshotNativePolicy(POLICY))
    expect(record.commandHash).toBe(createHash('sha256').update(secretCommand).digest('hex'))
    expect(record.commandBytes).toBe(Buffer.byteLength(secretCommand))
    expect(JSON.stringify(record)).not.toContain('super-secret-token')
    expect('command' in record).toBe(false)

    await fiber.dispose()
    expect(raw.run).toBe(originalRun)
    expect(raw.start).toBe(originalStart)
    await ctx.fiber.dispose()
  })

  it('settles background evidence only after the same returned process handle finishes', async () => {
    const ctx = new Context()
    const fake = new FakeShellExecutor(ctx)
    const done = deferred()
    const process = fakeProcess(done.promise)
    fake.nextProcess = process
    await ctx.plugin(nativeEvidence, {})

    const spec = ctx.shell.resolve({ command: 'sleep 1', sandboxPolicy: POLICY })
    const returned = ctx.shell.start(spec)
    expect(returned).toBe(process)
    expect(ctx.orcanaLinuxEvidence.pendingBackground).toBe(1)
    expect(ctx.orcanaLinuxEvidence.totalRecorded).toBe(0)

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
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(ctx.orcanaLinuxEvidence.pendingBackground).toBe(0)
    expect(ctx.orcanaLinuxEvidence.totalRecorded).toBe(1)
    expect(ctx.orcanaLinuxEvidence.ledger[0]).toMatchObject({
      kind: 'background',
      outcome: 'completed',
      exitCode: 0,
      evidenceKind: 'native-receipt',
    })
    await ctx.fiber.dispose()
  })

  it('records danger-full-access honestly without fabricating a native receipt', async () => {
    const ctx = new Context()
    const fake = new FakeShellExecutor(ctx)
    fake.runResult = {
      ...fake.runResult,
      sandbox: { mode: 'danger-full-access', denied: false },
    }
    await ctx.plugin(nativeEvidence, {})
    const spec = ctx.shell.resolve({
      command: 'echo open',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/repo' },
    })
    await ctx.shell.run(spec)
    const record = ctx.orcanaLinuxEvidence.ledger[0]!
    expect(record.evidenceKind).toBe('sandbox-facts')
    expect(record.sandbox?.mode).toBe('danger-full-access')
    expect(record.sandbox?.receipt).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('records infrastructure routing identity but rethrows the exact error', async () => {
    const ctx = new Context()
    const fake = new FakeShellExecutor(ctx)
    const error = Object.assign(new Error('secret infrastructure detail'), { code: 'SANDBOX_UNAVAILABLE' })
    fake.runError = error
    await ctx.plugin(nativeEvidence, {})
    const spec = ctx.shell.resolve({ command: 'echo blocked', sandboxPolicy: POLICY })

    await expect(ctx.shell.run(spec)).rejects.toBe(error)
    expect(ctx.orcanaLinuxEvidence.ledger[0]).toMatchObject({
      outcome: 'infrastructure-error',
      evidenceKind: 'none',
      error: { name: 'Error', code: 'SANDBOX_UNAVAILABLE' },
    })
    expect(JSON.stringify(ctx.orcanaLinuxEvidence.ledger[0])).not.toContain('secret infrastructure detail')
    await ctx.fiber.dispose()
  })

  it('is bounded and fails loud on a duplicate live observer', async () => {
    const ctx = new Context()
    new FakeShellExecutor(ctx)
    await ctx.plugin(nativeEvidence, { ledgerMaxEntries: 2 })
    for (let i = 0; i < 5; i += 1) {
      const spec = ctx.shell.resolve({ command: `echo ${i}`, sandboxPolicy: POLICY })
      await ctx.shell.run(spec)
    }
    expect(ctx.orcanaLinuxEvidence.ledger).toHaveLength(2)
    expect(ctx.orcanaLinuxEvidence.totalRecorded).toBe(5)
    expect(ctx.orcanaLinuxEvidence.droppedCount).toBe(3)

    let error: unknown
    try {
      await ctx.plugin(nativeEvidence, {})
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DuplicateNativeEvidenceError)
    expect((error as DuplicateNativeEvidenceError).code).toBe('DUPLICATE_NATIVE_EVIDENCE_INSTANCE')
    await ctx.fiber.dispose()
  })
})

describe.skipIf(!bwrapUsable)('native evidence through real DSH sandbox/shell', () => {
  it('observes the DSH receipt without changing sandbox argv or enforcement ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', network: 'none' })
    await ctx.plugin(SandboxBashExecutor, {})

    const policy = ctx.sandboxPolicy.resolve()
    const argvBefore = ctx.sandbox.confine(['bash', '-c', 'true'], { ...policy, mode: 'read-only' }).argv
    await ctx.plugin(nativeEvidence, {})
    const argvAfter = ctx.sandbox.confine(['bash', '-c', 'true'], { ...policy, mode: 'read-only' }).argv
    expect(argvAfter).toEqual(argvBefore)
    expect(argvAfter.filter((value) => value === '--unshare-net')).toHaveLength(1)

    const spec = ctx.shell.resolve({ command: 'printf native-evidence', sandboxPolicy: policy })
    const result = await ctx.shell.run(spec)
    expect(result.exitCode).toBe(0)
    expect(result.sandbox?.receipt?.layers).toContain('network-none')

    const record = ctx.orcanaLinuxEvidence.ledger.at(-1)!
    expect(record.evidenceKind).toBe('native-receipt')
    expect(record.sandbox?.receipt?.layers).toContain('network-none')
    expect(record.scope).toBeUndefined()
    expect(ctx.orcanaLinuxEvidence.scope.enforcementOwner).toBe('dsh')
    await ctx.fiber.dispose()
  })
})
