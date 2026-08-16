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

import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const BUDGETS = Object.freeze({
  /** Primary budget: model requests directly measure work (PLAN 5.3). */
  maxLLMCalls: 40,
  /** Wall fence: reached means INCOMPLETE_TIMEOUT, never waits for DSH. */
  wallTimeoutMs: 30 * 60 * 1000,
  /** SIGTERM grace before SIGKILL. */
  graceMs: 5000,
  /** Session-log poll interval for the call budget. */
  pollMs: 2000,
})

/** Environment pin shared by both arms (PLAN 5.2). */
export const ENV_PIN = Object.freeze({
  DSH_PERMISSION_MODE: 'danger-full-access',
  // DSH_TELEMETRY_MODE unset = default DISABLED; DSH_TOOLS_MODE unset.
  // Run-time outbound network is denied at the OS layer by the caller
  // (unshare -n or container); the tool-level web ban lives in the shared
  // bench profile patch.
})

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
 * @param budgetHit - `'calls'`, `'wall'`, or undefined.
 * @param exitCode - DSH's exit code (informational only).
 * @param signal - terminating signal, when killed.
 * @returns the supervisor verdict.
 */
export function outcomeOf({ budgetHit, exitCode, signal }) {
  if (budgetHit === 'wall') return { outcome: OUTCOMES.INCOMPLETE_TIMEOUT, reason: 'wall_time_budget_exhausted', exitCode, signal }
  if (budgetHit === 'calls') return { outcome: OUTCOMES.INCOMPLETE_CALLS, reason: 'llm_call_budget_exhausted', exitCode, signal }
  if (exitCode !== null) return { outcome: OUTCOMES.COMPLETED, reason: 'exited', exitCode, signal }
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
  return recordRun({ runHome, startedAt, verdict, arm, manifest, stdout, stderr, reportsDir })
}

function recordRun({ runHome, startedAt, verdict, arm, manifest, stdout, stderr, reportsDir }) {
  const record = {
    task_id: manifest.task_id,
    arm,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    verdict,
    home: runHome,
    prompt_sha256: manifest.source?.prompt_sha256,
    manifest_digest: manifest.digest,
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
 * CLI entry: `--dry-run` (default) prints the plan and exits; `--live` runs
 * the plan. Flags: --manifests <dir> (JSON manifests), --template <dir>,
 * --reports <dir>, --seed <n>, --reps <n>, --task <id> (filter), --arm
 * <control|treatment> (filter).
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
  return 1 // live scheduling lands with the task pipeline; not enabled here
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv)
}
