/**
 * Supervisor live tests: runOne against a fake dsh — the budget monitor,
 * SIGTERM/SIGKILL grace, and the authoritative verdicts, end to end.
 * Uses real child processes and intentionally small budgets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OUTCOMES, countAssistantMessages, runLive, runOne } from '../supervisor.mjs'

const BUDGETS = { maxLLMCalls: 3, wallTimeoutMs: 5000, graceMs: 400, pollMs: 100 }
let fakeDsh
let work

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'bench-live-'))
  fakeDsh = join(work, 'fake-dsh.sh')
  execFileSync('cp', [join(import.meta.dirname, 'fixtures', 'fake-dsh.sh'), fakeDsh])
  chmodSync(fakeDsh, 0o755)
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

function templateWith(sessionsDir) {
  const template = join(work, `template-${Math.random().toString(36).slice(2)}`)
  if (sessionsDir) mkdirSync(join(template, 'sessions'), { recursive: true })
  else mkdirSync(template, { recursive: true })
  return template
}

const MANIFEST = { task_id: 'fake-task', prompt: 'do something', source: { prompt_sha256: 'abc' }, digest: 'd' }

describe('runOne (live, fake dsh)', () => {
  it('natural exit 0 → completed (success is the judges call)', async () => {
    const record = await runOne({
      manifest: MANIFEST,
      arm: 'control',
      workspace: work,
      template: templateWith(false),
      budgets: BUDGETS,
      dsh: fakeDsh,
      env: { FAKE_CALLS: '1', FAKE_EXIT: '0' },
    })
    expect(record.verdict.outcome).toBe(OUTCOMES.COMPLETED)
    expect(record.verdict.exitCode).toBe(0)
    rmSync(record.home, { recursive: true, force: true })
  })

  it('call-budget exhaustion → incomplete, never success', async () => {
    const record = await runOne({
      manifest: MANIFEST,
      arm: 'treatment',
      workspace: work,
      template: templateWith(false),
      budgets: BUDGETS,
      dsh: fakeDsh,
      env: { FAKE_CALLS: '5', FAKE_SLEEP: '30' },
    })
    expect(record.verdict.outcome).toBe(OUTCOMES.INCOMPLETE_CALLS)
    expect(record.verdict.reason).toBe('llm_call_budget_exhausted')
    rmSync(record.home, { recursive: true, force: true })
  })

  it('wall exhaustion → SIGTERM, then SIGKILL for a term-ignoring child', async () => {
    const record = await runOne({
      manifest: MANIFEST,
      arm: 'control',
      workspace: work,
      template: templateWith(false),
      budgets: { ...BUDGETS, wallTimeoutMs: 1500 },
      dsh: fakeDsh,
      env: { FAKE_CALLS: '0', FAKE_SLEEP: '30', FAKE_IGNORE_TERM: '1' },
    })
    expect(record.verdict.outcome).toBe(OUTCOMES.INCOMPLETE_TIMEOUT)
    expect(record.verdict.reason).toBe('wall_time_budget_exhausted')
    rmSync(record.home, { recursive: true, force: true })
  }, 20000)

  it('the budget monitor counts through the isolated run home', async () => {
    const template = templateWith(false)
    const record = await runOne({
      manifest: MANIFEST,
      arm: 'control',
      workspace: work,
      template,
      budgets: { maxLLMCalls: 10, wallTimeoutMs: 5000, graceMs: 400, pollMs: 100 },
      dsh: fakeDsh,
      env: { FAKE_CALLS: '2', FAKE_EXIT: '0' },
    })
    expect(countAssistantMessages(record.home)).toBe(2)
    rmSync(record.home, { recursive: true, force: true })
  })
})

describe('runLive (end to end with the demo workspace)', () => {
  it('folds metrics and judges against the real acceptance command', async () => {
    const rows = await runLive(
      [{ task: 'demo-format-money', arm: 'control', taskIndex: 0, rep: 0 }],
      [{
        task_id: 'demo-format-money',
        workspace: 'tasks/demo/repo',
        verification: { acceptance: 'npm test && node reproducer.js' },
        source: { prompt_sha256: 'abc' },
        digest: 'd',
      }],
      {
        template: templateWith(false),
        budgets: { maxLLMCalls: 10, wallTimeoutMs: 5000, graceMs: 400, pollMs: 100 },
        dsh: fakeDsh,
        env: { FAKE_CALLS: '1', FAKE_EXIT: '0' },
      },
    )
    const row = rows[0]
    // Fake dsh exits 0 quickly: completed. No assistant claim text (fake
    // dsh only writes tool-less assistant messages) → the judge sees the
    // buggy base failing its acceptance as a plain fail.
    expect(row.record.verdict.outcome).toBe(OUTCOMES.COMPLETED)
    expect(row.judgment.verdict).toBe('failed')
    expect(row.metrics.llm_calls).toBe(1)
    expect(row.wallMs).toBeGreaterThan(0)
    rmSync(row.record.home, { recursive: true, force: true })
  }, 30000)
})
