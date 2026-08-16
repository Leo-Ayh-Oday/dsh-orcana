/**
 * Benchmark supervisor (P6): orchestrates the paired A/B runs.
 *
 * Responsibilities (PLAN 5.2–5.4, frozen invariants):
 * - isolated `DSH_HOME` per run, copied from bench-home-template
 *   (`cp -a --reflink=auto`, fallback to plain copy)
 * - environment pin: DSH_PERMISSION_MODE=danger-full-access, telemetry off
 * - budgets: 40 LLM calls primary (polled from the run home's session logs),
 *   30 min wall fence, 5 s SIGTERM grace, then SIGKILL
 * - authoritative verdicts: wall/call exhaustion is `incomplete` BEFORE any
 *   exit code; DSH's exit 0 is never success — the judge decides
 * - paired runs: per task, randomized arm order (deterministic seed), pairs
 *   scheduled consecutively
 * - retry only on infrastructure failure; result-level runs never retry
 *
 * Self-contained (no package imports), dry-run by default.
 * @module orcana-benchmark/supervisor
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { aggregateSessions, renderMetricsRow } from './aggregate.mjs'
import { claimedCompletion, judgeVerdict, lastClaimText, runAcceptance } from './judge.mjs'
export const BUDGETS = Object.freeze({
  /** Primary budget: model requests directly measure work (PLAN 5.3). */
  maxLLMCalls: 40,
  /** Wall fence: reached means INCOMPLETE_TIMEOUT, never waits for DSH. */
  wallTimeoutMs: 30 * 60 * 1000,
  /** SIGTERM grace before SIGKILL. */
  graceMs: 5000,
  /** Session-log poll interval for the call/token budgets. */
  pollMs: 2000,
  /** Cost fuse (PLAN 5.3): cumulative input+output+cacheRead tokens; 0 = off. */
  maxSessionTokens: 0,
})

/** Environment pin shared by both arms (PLAN 5.2). */
export const ENV_PIN = Object.freeze({
  DSH_PERMISSION_MODE: 'danger-full-access',
})

/** Variables that must be ABSENT from a run (telemetry/tools mode default-off). */
export const ENV_STRIP = Object.freeze(['DSH_TELEMETRY_MODE', 'DSH_TOOLS_MODE'])

/** Arm names. */
export const ARMS = Object.freeze({ CONTROL: 'control', TREATMENT: 'treatment' })

/** Outcome verdicts the supervisor owns (PLAN 5.3). */
export const OUTCOMES = Object.freeze({
  /** Wall fence hit; authority = supervisor, independent of exit code. */
  INCOMPLETE_TIMEOUT: 'incomplete',
  /** LLM-call budget exhausted. */
  INCOMPLETE_CALLS: 'incomplete',
  /** Natural exit; success is NOT implied — the judge decides. */
  COMPLETED: 'completed',
  /** Spawn/IO failure; the only retryable class. */
  INFRA_FAILURE: 'infra-failure',
})

/**
 * Deterministic PRNG (mulberry32) so a seed reproduces the exact arm order.
 */
export function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The ordered arms for one task under a deterministic seed: `[control,
 * treatment]` or `[treatment, control]` with p = 1/2.
 * @param taskIndex - the task's position in the manifest list.
 * @param seed - reproducibility seed.
 * @returns the arm order for this task's pair.
 */
export function armOrder(taskIndex, seed) {
  const rand = mulberry32(seed + taskIndex * 0x9e3779b9)
  return rand() < 0.5 ? [ARMS.CONTROL, ARMS.TREATMENT] : [ARMS.TREATMENT, ARMS.CONTROL]
}

/**
 * The full run plan: for each task (in manifest order), `reps` consecutive
 * pairs, arms in the deterministic order. Pairs of the same task stay
 * consecutive so provider-side drift hits both arms similarly (PLAN 5.4).
 * @param manifests - frozen task manifests ({ task_id, prompt }).
 * @param options - { seed, reps }.
 * @returns the ordered run list: { task, arm, taskIndex, run }.
 */
export function planRuns(manifests, { seed = 1, reps = 1 } = {}) {
  const runs = []
  manifests.forEach((manifest, taskIndex) => {
    for (let rep = 0; rep < reps; rep += 1) {
      for (const arm of armOrder(taskIndex, seed)) {
        runs.push({ task: manifest.task_id, arm, taskIndex, rep })
      }
    }
  })
  return runs
}

/**
 * Authoritative outcome of one run: budget exhaustion wins over any exit
 * code; only natural exits reach `completed`, and even then the judge owns
 * success.
 * @param budgetHit - `'calls'`, `'wall'`, `'cost'`, or undefined.
 * @param exitCode - DSH's exit code (informational only).
 * @param signal - terminating signal, when killed.
 * @returns the supervisor verdict.
 */
export function outcomeOf({ budgetHit, exitCode, signal }) {
  if (budgetHit === 'wall') return { outcome: OUTCOMES.INCOMPLETE_TIMEOUT, reason: 'wall_time_budget_exhausted', exitCode, signal }
  if (budgetHit === 'calls') return { outcome: OUTCOMES.INCOMPLETE_CALLS, reason: 'llm_call_budget_exhausted', exitCode, signal }
  if (budgetHit === 'cost') return { outcome: OUTCOMES.INCOMPLETE_CALLS, reason: 'cost_ceiling_hit', exitCode, signal }
  if (exitCode !== null) return { outcome: OUTCOMES.COMPLETED, reason: 'exited', exitCode, signal }
  if (signal !== null) return { outcome: OUTCOMES.INFRA_FAILURE, reason: 'terminated_by_signal', exitCode, signal }
  return { outcome: OUTCOMES.INFRA_FAILURE, reason: 'spawn_failed', exitCode, signal }
}

/** Reflink copy of the template into a fresh run home (fallback: plain copy). */
export function copyTemplate(template, dest) {
  mkdirSync(join(dest, '..'), { recursive: true })
  try {
    execFileSync('cp', ['-a', '--reflink=auto', template, dest], { stdio: 'ignore' })
  } catch {
    execFileSync('cp', ['-a', template, dest], { stdio: 'ignore' })
  }
}

/**
 * Count assistant messages in a run home's session logs — the LLM-call
 * budget counter. Every `assistant/message` event is one model request;
 * the count is read fresh per poll so in-flight batches appear as they land
 * (the last in-flight batch may be lost at kill — durability semantics).
 */
export function countAssistantMessages(home) {
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) return 0
  let calls = 0
  for (const ns of readdirSync(sessions)) {
    const nsDir = join(sessions, ns)
    if (!existsSync(nsDir)) continue
    for (const session of readdirSync(nsDir)) {
      const log = join(nsDir, session, 'session.jsonl.zstd')
      if (!existsSync(log)) continue
      const text = execFileSync('zstd', ['-dc', log], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      calls += (text.match(/"type":"assistant\/message"/g) ?? []).length
    }
  }
  return calls
}

/**
 * Cumulative input+output+cacheRead tokens across a run home's session
 * logs — the cost-fuse counter (PLAN 5.3). 0 when the fuse is off.
 */
export function countSessionTokens(home) {
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) return 0
  let tokens = 0
  for (const ns of readdirSync(sessions)) {
    const nsDir = join(sessions, ns)
    if (!existsSync(nsDir)) continue
    for (const session of readdirSync(nsDir)) {
      const log = join(nsDir, session, 'session.jsonl.zstd')
      if (!existsSync(log)) continue
      const text = execFileSync('zstd', ['-dc', log], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of text.split('\n')) {
        const usage = /"usage":\{"inputTokens":(\d+)(,"outputTokens":(\d+))?(,"cacheReadTokens":(\d+))?/.exec(line)
        if (usage === null) continue
        tokens += Number(usage[1] ?? 0) + Number(usage[3] ?? 0) + Number(usage[5] ?? 0)
      }
    }
  }
  return tokens
}

/** Run-environment pins recorded with every run (PLAN 7, methodology 8). */
export function collectPins({ dsh = 'dsh' } = {}) {
  let dshVersion
  try {
    dshVersion = execFileSync(dsh, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    dshVersion = undefined
  }
  return {
    node: process.version,
    dsh: dshVersion,
    platform: process.platform,
    arch: process.arch,
    kernel: osRelease(),
  }
}

/** SHA-256 hex digest of a file, or undefined when unreadable. */
export function fileDigest(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return undefined
  }
}

function osRelease() {
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim()
  } catch {
    return undefined
  }
}

/**
 * Run one (task, arm) under the budgets, returning the supervisor verdict
 * plus run facts (home, session count, timestamps).
 * @param options - { manifest, arm, workspace, template, reportsDir, budgets, env, dsh }
 * @returns the run record with the authoritative outcome.
 */
export async function runOne({
  manifest,
  arm,
  workspace,
  template,
  reportsDir,
  budgets = BUDGETS,
  env = {},
  dsh = 'dsh',
}) {
  const patch = join(import.meta.dirname, '..', 'patches', `${arm}.patch.yml`)
  const runHome = join(template, '..', `run-home-${arm}-${manifest.task_id}-${Date.now()}`)
  copyTemplate(template, runHome)
  const startedAt = new Date().toISOString()
  const wallDeadline = Date.now() + budgets.wallTimeoutMs
  const fullEnv = { ...process.env, ...ENV_PIN, ...env, DSH_HOME: runHome }
  for (const key of ENV_STRIP) delete fullEnv[key]
  const pins = collectPins({ dsh })
  pins.profile_config_digest = fileDigest(join(runHome, 'profiles', 'bench', 'cordis.patch.yml'))

  const child = spawn(dsh, ['--profile', 'bench', '--patch', patch, manifest.prompt], {
    cwd: workspace,
    env: fullEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })

  let budgetHit
  let exitCode = null
  let signal
  let exited = false
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, sig) => {
      exitCode = code
      signal = sig
      exited = true
      resolve()
    })
  })

  try {
    while (!exited) {
      if (countAssistantMessages(runHome) >= budgets.maxLLMCalls) {
        budgetHit = 'calls'
        break
      }
      if (budgets.maxSessionTokens > 0 && countSessionTokens(runHome) >= budgets.maxSessionTokens) {
        budgetHit = 'cost'
        break
      }
      if (Date.now() >= wallDeadline) {
        budgetHit = 'wall'
        break
      }
      await sleep(budgets.pollMs)
    }
    if (!exited) {
      // Budget reached: ordinary stop per PLAN 5.3, then grace, then SIGKILL.
      child.kill('SIGTERM')
      const grace = Promise.race([exitPromise, sleep(budgets.graceMs)])
      await grace
      if (!exited) {
        child.kill('SIGKILL')
        await exitPromise
      }
    } else {
      await exitPromise
    }
  } catch (error) {
    const verdict = { outcome: OUTCOMES.INFRA_FAILURE, reason: 'supervisor_error', error: String(error) }
    return recordRun({ runHome, startedAt, verdict, arm, manifest, stdout, stderr })
  }

  const verdict = outcomeOf({ budgetHit, exitCode, signal })
  return recordRun({ runHome, startedAt, verdict, arm, manifest, stdout, stderr, reportsDir, fullEnv, pins })
}

function recordRun({ runHome, startedAt, verdict, arm, manifest, stdout, stderr, reportsDir, fullEnv, pins }) {
  const record = {
    task_id: manifest.task_id,
    arm,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    verdict,
    home: runHome,
    prompt_sha256: manifest.source?.prompt_sha256,
    manifest_digest: manifest.digest,
    pins,
    env_pin: {
      DSH_PERMISSION_MODE: fullEnv?.DSH_PERMISSION_MODE,
      telemetry: fullEnv !== undefined && !('DSH_TELEMETRY_MODE' in fullEnv) ? 'unset' : 'leaked',
      tools_mode: fullEnv !== undefined && !('DSH_TOOLS_MODE' in fullEnv) ? 'unset' : 'leaked',
    },
    stdout_tail: stdout.slice(-4000),
    stderr_tail: stderr.slice(-2000),
  }
  if (reportsDir !== undefined) {
    mkdirSync(reportsDir, { recursive: true })
    const stamp = startedAt.replace(/[:.]/g, '-')
    writeFileSync(join(reportsDir, `run-${manifest.task_id}-${arm}-${stamp}.json`), JSON.stringify(record, null, 2))
  }
  return record
}

/**
 * Run the plan live: for each (task, arm), run the agent under the budgets,
 * fold the session metrics, apply the independent judge, and collect the
 * paired rows. Infrastructure failures (spawn/IO) retry once; result-level
 * outcomes never retry (PLAN 5.3).
 * @param plan - the run plan from {@link planRuns}.
 * @param manifests - frozen task manifests.
 * @param options - { template, reportsDir, budgets, dsh }.
 * @returns the per-run result rows.
 */
export async function runLive(plan, manifests, { template, reportsDir, budgets = BUDGETS, dsh = 'dsh', env = {} }) {
  const rows = []
  for (const run of plan) {
    const manifest = manifests.find(item => item.task_id === run.task)
    if (manifest === undefined) {
      console.error(`  manifest not found for task ${run.task}`)
      continue
    }
    const workspace = join(import.meta.dirname, '..', manifest.workspace ?? `tasks/${run.task}/repo`)
    const base = { manifest, arm: run.arm, workspace, template, reportsDir, budgets, dsh, env }
    let record = await runOne(base)
    if (record.verdict.outcome === OUTCOMES.INFRA_FAILURE) {
      console.log(`  infra failure, retrying once: ${run.task} [${run.arm}]`)
      record = await runOne(base)
      if (record.verdict.outcome === OUTCOMES.INFRA_FAILURE) {
        console.log('  retry also failed; recording infra-failure outcome')
      }
    }
    const sessions = join(record.home, 'sessions')
    const metrics = aggregateSessions(sessions)
    const claimed = claimedCompletion(lastClaimText(sessions))
    const acceptance = await runAcceptance(manifest.verification.acceptance, workspace)
    const judgment = judgeVerdict(acceptance, claimed)
    const wallMs = (Date.parse(record.finished_at) - Date.parse(record.started_at))
    rows.push({ task: run.task, arm: run.arm, record, metrics, judgment, wallMs })
    console.log(renderMetricsRow(metrics, {
      task_id: run.task,
      arm: run.arm,
      verdict: `${record.verdict.outcome}:${judgment.verdict}`,
    }))
  }
  if (reportsDir !== undefined) {
    mkdirSync(reportsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(reportsDir, `paired-${stamp}.json`), JSON.stringify(rows.map(row => ({
      task: row.task,
      arm: row.arm,
      verdict: row.record.verdict,
      judgment: row.judgment,
      metrics: row.metrics,
      wall_ms: row.wallMs,
    })), null, 2))
  }
  console.log(renderPairedReport(rows))
  return rows
}

/** One-line summary of a run row for the paired report. */
function describeRow(row) {
  if (row === undefined) return '(missing)'
  return `${row.record.verdict.outcome}:${row.judgment.verdict} calls=${row.metrics.llm_calls} wall=${Math.round(row.wallMs / 1000)}s`
}

/**
 * The paired report: per task, control vs treatment, with the paired deltas
 * (calls / tokens / wall). Pure, deterministic — tested.
 */
export function renderPairedReport(rows) {
  const lines = ['Paired report:']
  const byTask = new Map()
  for (const row of rows) {
    if (!byTask.has(row.task)) byTask.set(row.task, [])
    byTask.get(row.task).push(row)
  }
  for (const [task, pair] of [...byTask.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const control = pair.find(row => row.arm === ARMS.CONTROL)
    const treatment = pair.find(row => row.arm === ARMS.TREATMENT)
    lines.push(`  ${task}:`)
    lines.push(`    control:   ${describeRow(control)}`)
    lines.push(`    treatment: ${describeRow(treatment)}`)
    if (control !== undefined && treatment !== undefined) {
      const tokens = (row) => row.metrics.input_tokens + row.metrics.output_tokens
      lines.push(`    delta: calls=${treatment.metrics.llm_calls - control.metrics.llm_calls} `
        + `tokens=${tokens(treatment) - tokens(control)} wall_ms=${treatment.wallMs - control.wallMs}`)
    }
  }
  return lines.join('\n')
}

/**
 * CLI entry: `--dry-run` (default) prints the plan and exits; `--live` runs
 * the plan. Flags: --manifests <dir>, --template <dir>, --reports <dir>,
 * --seed <n>, --reps <n>, --task <id> (filter), --arm <control|treatment>
 * (filter), --max-calls <n>, --wall-ms <n>, --max-tokens <n> (budget
 * overrides).
 */
export function main(argv, env = process.env) {
  const args = argv.slice(2)
  const value = (name) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const manifestsDir = value('--manifests') ?? join(import.meta.dirname, '..', 'manifests')
  const template = value('--template') ?? join(import.meta.dirname, '..', 'bench-home-template')
  const reportsDir = value('--reports') ?? join(import.meta.dirname, '..', 'reports')
  const seed = Number(value('--seed') ?? 1)
  const reps = Number(value('--reps') ?? 1)
  const taskFilter = value('--task')
  const armFilter = value('--arm')
  const live = args.includes('--live')
  const budgets = {
    ...BUDGETS,
    maxLLMCalls: Number(value('--max-calls') ?? BUDGETS.maxLLMCalls),
    wallTimeoutMs: Number(value('--wall-ms') ?? BUDGETS.wallTimeoutMs),
    maxSessionTokens: Number(value('--max-tokens') ?? BUDGETS.maxSessionTokens),
  }

  const manifests = []
  if (existsSync(manifestsDir)) {
    for (const name of readdirSync(manifestsDir).sort()) {
      if (!name.endsWith('.json')) continue
      const manifest = JSON.parse(readFileSync(join(manifestsDir, name), 'utf8'))
      manifests.push(manifest)
    }
  }
  let plan = planRuns(manifests, { seed, reps })
  if (taskFilter !== undefined) plan = plan.filter(run => run.task === taskFilter)
  if (armFilter !== undefined) plan = plan.filter(run => run.arm === armFilter)

  console.log(`orcana-dsh benchmark (${live ? 'live' : 'dry-run'})`)
  console.log(`manifests: ${manifests.map(m => m.task_id).join(', ') || '(none)'}`)
  console.log(`plan rows (paired, seed=${seed}, reps=${reps}): ${plan.length}`)
  for (const run of plan) console.log(`  ${run.task} [${run.arm}]`)

  if (!live) {
    console.log('dry-run: nothing was executed')
    return 0
  }
  return runLive(plan, manifests, { template, reportsDir, budgets, dsh: env.DSH_BIN ?? 'dsh' }).then(() => 0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = main(process.argv)
  if (code instanceof Promise) {
    code.then(exit => { process.exitCode = exit }).catch(error => {
      console.error(error)
      process.exitCode = 1
    })
  } else {
    process.exitCode = code
  }
}
