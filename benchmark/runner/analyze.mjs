/**
 * Offline analysis (P7 data side): fold the recorded runs in `reports/`
 * into the paired report (PLAN 5.8): paired success/call/token/wall deltas
 * per task, the pinned environment record, and — when session homes are
 * available — the discipline metrics (zero-progress rounds, duplicate
 * reads/commands) rebuilt from the session logs via governor-core.
 *
 * Pure and dependency-free for the metric part; the discipline part loads
 * @leooday/governor-core when resolvable and is skipped otherwise (labeled).
 * @module orcana-benchmark/analyze
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Load every run record JSON under a reports directory. */
export function loadRunRecords(reportsDir) {
  if (!existsSync(reportsDir)) return []
  const records = []
  for (const name of readdirSync(reportsDir).sort()) {
    if (!name.startsWith('run-') || !name.endsWith('.json')) continue
    try {
      records.push(JSON.parse(readFileSync(join(reportsDir, name), 'utf8')))
    } catch (error) {
      console.error(`  skipping unreadable ${name}: ${error.message}`)
    }
  }
  return records
}

/** Token sum of a run record (input+output+cacheRead, from the session metrics). */
export function tokenSum(record) {
  const m = record.metrics ?? {}
  return (m.input_tokens ?? 0) + (m.output_tokens ?? 0) + (m.cache_read_tokens ?? 0)
}

/** Wall ms between the recorded timestamps. */
export function wallMs(record) {
  return Date.parse(record.finished_at ?? '') - Date.parse(record.started_at ?? '')
}

/**
 * Fold records into per-task paired rows: { task, reps: [{ control,
 * treatment, deltas }] }. Deterministic, tested.
 */
export function foldPairs(records) {
  const byTask = new Map()
  for (const record of records) {
    if (!byTask.has(record.task_id)) byTask.set(record.task_id, [])
    byTask.get(record.task_id).push(record)
  }
  const rows = []
  for (const [task, runs] of [...byTask.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const controls = runs.filter(run => run.arm === 'control')
    const treatments = runs.filter(run => run.arm === 'treatment')
    const reps = Math.max(controls.length, treatments.length)
    const repRows = []
    for (let rep = 0; rep < reps; rep += 1) {
      const control = controls[rep]
      const treatment = treatments[rep]
      repRows.push({
        control: control ? { verdict: control.verdict, metrics: control.metrics ?? {}, wall: wallMs(control) } : undefined,
        treatment: treatment ? { verdict: treatment.verdict, metrics: treatment.metrics ?? {}, wall: wallMs(treatment) } : undefined,
        deltas: control !== undefined && treatment !== undefined ? {
          calls: (treatment.metrics?.llm_calls ?? 0) - (control.metrics?.llm_calls ?? 0),
          tokens: tokenSum(treatment) - tokenSum(control),
          wall_ms: wallMs(treatment) - wallMs(control),
        } : undefined,
      })
    }
    rows.push({ task, reps: repRows })
  }
  return rows
}

/** One-line run summary for the report. */
export function describeRun(run) {
  if (run === undefined) return '(missing)'
  const verdict = `${run.verdict?.outcome ?? '?'}:${run.verdict?.reason ?? ''}`
  const calls = run.metrics?.llm_calls ?? 0
  return `${verdict} calls=${calls} wall=${Math.round(run.wall / 1000)}s`
}

/**
 * The paired report text: per task and rep, control vs treatment, with the
 * paired deltas. Stable format — tested.
 */
export function renderAnalysis(rows) {
  const lines = ['Analysis:']
  for (const row of rows) {
    row.reps.forEach((repRow, rep) => {
      lines.push(`  ${row.task} (rep ${rep}):`)
      lines.push(`    control:   ${describeRun(repRow.control)}`)
      lines.push(`    treatment: ${describeRun(repRow.treatment)}`)
      if (repRow.deltas !== undefined) {
        lines.push(`    delta: calls=${repRow.deltas.calls} tokens=${repRow.deltas.tokens} wall_ms=${repRow.deltas.wall_ms}`)
      }
    })
  }
  return lines.join('\n')
}

/**
 * Discipline metrics rebuilt from a run home's session logs: zero-progress
 * rounds, duplicate reads, and duplicate verification commands. Uses
 * @leooday/governor-core's ProgressFactEngine through the adapter's replay
 * translation when the packages resolve; otherwise undefined (labeled skip).
 * @param home - the run home (contains `sessions/`).
 * @returns { zeroProgressRounds, duplicateReads, duplicateCommands } or undefined.
 */
export async function disciplineMetrics(home) {
  let governor
  let adapter
  try {
    governor = await import('@leooday/governor-core')
    adapter = await import('@leooday/dsh-governor')
  } catch {
    return undefined
  }
  const { ProgressFactEngine } = governor
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) return undefined
  const events = []
  for (const ns of readdirSync(sessions)) {
    const nsDir = join(sessions, ns)
    if (!existsSync(nsDir)) continue
    for (const session of readdirSync(nsDir)) {
      const log = join(nsDir, session, 'session.jsonl.zstd')
      if (!existsSync(log)) continue
      const text = execFileSync('zstd', ['-dc', log], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of text.split('\n')) {
        let event
        try { event = JSON.parse(line.trim()) } catch { continue }
        if (event?.type === 'tool/call' || event?.type === 'tool/result') events.push({ type: event.type, data: event.data })
      }
    }
  }
  if (events.length === 0) return undefined
  const engine = ProgressFactEngine.rebuild(adapter.translateSessionEvents(events))
  const duplicateReads = new Map()
  const duplicateCommands = new Map()
  for (const entry of engine.snapshot().ring) {
    if (entry.tool === 'read') duplicateReads.set(entry.canonicalArgs, (duplicateReads.get(entry.canonicalArgs) ?? 0) + 1)
    if (entry.tool === 'bash' && entry.command !== undefined) {
      duplicateCommands.set(entry.command, (duplicateCommands.get(entry.command) ?? 0) + 1)
    }
  }
  return {
    zeroProgressRounds: engine.zeroProgressChain(),
    duplicateReads: [...duplicateReads.values()].filter(count => count > 1).length,
    duplicateCommands: [...duplicateCommands.values()].filter(count => count > 1).length,
  }
}

/**
 * CLI: analyze.mjs --reports <dir> [--sessions <run-home-dir>] [--out <file>].
 * Reads run records, prints the paired analysis, optionally appends the
 * discipline metrics for each run home under --sessions, and writes the
 * full report JSON when --out is given.
 */
export async function main(argv) {
  const args = argv.slice(2)
  const value = (name) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const reportsDir = value('--reports') ?? join(import.meta.dirname, '..', 'reports')
  const sessionsDir = value('--sessions')
  const out = value('--out')

  const records = loadRunRecords(reportsDir)
  const rows = foldPairs(records)
  console.log(`orcana-dsh analysis: ${records.length} run records from ${reportsDir}`)
  console.log(renderAnalysis(rows))

  const report = { generated_at: new Date().toISOString(), rows: [], pins: {} }
  for (const row of rows) {
    for (const [rep, repRow] of row.reps.entries()) {
      const entry = { task: row.task, rep }
      for (const arm of ['control', 'treatment']) {
        const run = repRow[arm]
        if (run === undefined) continue
        entry[arm] = { verdict: run.verdict, metrics: run.metrics, wall_ms: run.wall }
      }
      entry.deltas = repRow.deltas
      report.rows.push(entry)
    }
  }
  if (sessionsDir !== undefined && existsSync(sessionsDir)) {
    for (const record of records) {
      const home = join(sessionsDir, record.home ? record.home.split('/').pop() : '')
      const metrics = existsSync(home) ? await disciplineMetrics(home) : undefined
      if (metrics !== undefined) report.pins[`${record.task_id}/${record.arm}`] = metrics
    }
  }
  if (out !== undefined) {
    writeFileSync(out, JSON.stringify(report, null, 2))
    console.log(`report written to ${out}`)
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then(code => { process.exitCode = code }).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
