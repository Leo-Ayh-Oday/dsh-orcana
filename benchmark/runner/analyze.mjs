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

/**
 * Load the paired rows (metrics + judgment live in the paired files, not in
 * the per-run records). Every paired-*.json under the reports directory is
 * folded in.
 */
export function loadPairedRecords(reportsDir) {
  if (!existsSync(reportsDir)) return []
  const rows = []
  for (const name of readdirSync(reportsDir).sort()) {
    if (!name.startsWith('paired-') || !name.endsWith('.json')) continue
    try {
      const data = JSON.parse(readFileSync(join(reportsDir, name), 'utf8'))
      const sourceRows = Array.isArray(data) ? data : (data.rows ?? [])
      for (const row of sourceRows) rows.push({ ...row, source: name })
    } catch (error) {
      console.error(`  skipping unreadable ${name}: ${error.message}`)
    }
  }
  return rows
}

/** Token sum of a run record (input+output, matching the live paired report). */
export function tokenSum(record) {
  const m = record.metrics ?? {}
  return (m.input_tokens ?? 0) + (m.output_tokens ?? 0)
}

/** Wall ms between the recorded timestamps. */
export function wallMs(record) {
  return Date.parse(record.finished_at ?? '') - Date.parse(record.started_at ?? '')
}

/**
 * Fold paired rows into per-task paired rows: { task, reps: [{ control,
 * treatment, deltas }] }. Deterministic, tested. Rows may come from the
 * paired files (metrics/judgment) or run records (verdict only).
 */
export function foldPairs(rows) {
  const byTask = new Map()
  for (const row of rows) {
    const task = row.task ?? row.task_id
    if (!byTask.has(task)) byTask.set(task, [])
    byTask.get(task).push(row)
  }
  const out = []
  for (const [task, runs] of [...byTask.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const controls = runs.filter(run => run.arm === 'control')
    const treatments = runs.filter(run => run.arm === 'treatment')
    const reps = Math.max(controls.length, treatments.length)
    const repRows = []
    for (let rep = 0; rep < reps; rep += 1) {
      const control = controls[rep]
      const treatment = treatments[rep]
      repRows.push({
        control: control ? { verdict: control.verdict, judgment: control.judgment, metrics: control.metrics ?? {}, wall: wallOf(control) } : undefined,
        treatment: treatment ? { verdict: treatment.verdict, judgment: treatment.judgment, metrics: treatment.metrics ?? {}, wall: wallOf(treatment) } : undefined,
        deltas: control !== undefined && treatment !== undefined ? {
          calls: (treatment.metrics?.llm_calls ?? 0) - (control.metrics?.llm_calls ?? 0),
          tokens: tokenSum(treatment) - tokenSum(control),
          wall_ms: wallOf(treatment) - wallOf(control),
        } : undefined,
      })
    }
    out.push({ task, reps: repRows })
  }
  return out
}

/** Wall ms of a row: recorded wall_ms (paired files) or timestamps (run records). */
function wallOf(row) {
  if (row.wall_ms !== undefined && row.wall_ms !== null) return row.wall_ms
  if (row.wallMs !== undefined && row.wallMs !== null) return row.wallMs
  return wallMs(row)
}

/** One-line run summary for the report. */
export function describeRun(run) {
  if (run === undefined) return '(missing)'
  const verdict = `${run.verdict?.outcome ?? '?'}:${run.judgment?.verdict ?? run.verdict?.reason ?? ''}`
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
 * Resolve the governor packages for discipline replay. Workspace links live
 * on the dependency side (pnpm), so try the package name first, then the
 * compiled libs relative to this file.
 */
async function loadGovernor() {
  const core = await tryLoad('core')
  const adapter = await tryLoad('adapter')
  return core !== undefined && adapter !== undefined ? { core, adapter } : undefined
}

async function tryLoad(kind) {
  const isCore = kind === 'core'
  const candidates = [
    isCore ? '@leooday/governor-core' : '@leooday/dsh-governor',
    isCore ? '../../packages/governor-core/lib/index.js' : '../../packages/dsh-governor/lib/index.js',
  ]
  for (const candidate of candidates) {
    try {
      return await import(candidate)
    } catch {
      // try the next candidate
    }
  }
  return undefined
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
  const { core, adapter } = await loadGovernor() ?? {}
  if (core === undefined || adapter === undefined) return undefined
  const { ProgressFactEngine } = core
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
        if (event?.type === 'tool/call' || event?.type === 'tool/result' || event?.type === 'turn/end') {
          events.push({ type: event.type, data: event.data })
        }
      }
    }
  }
  if (events.length === 0) return undefined
  const engine = new ProgressFactEngine()
  const pending = new Map()
  let zeroProgressRounds = 0
  for (const event of events) {
    if (event.type === 'tool/call') {
      pending.set(event.data.callId, { callId: event.data.callId, name: event.data.name, arguments: event.data.arguments })
    } else if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      const call = pending.get(block.callId)
      if (call === undefined) continue
      engine.applyEvent(adapter.toEngineEvent(
        { callId: call.callId, name: call.name, arguments: parseArguments(call.arguments) },
        { content: block.content, isError: block.isError },
      ))
    } else if (event.type === 'turn/end') {
      if (engine.endTurn().zeroProgress) zeroProgressRounds += 1
    }
  }
  const duplicateReads = new Map()
  const duplicateCommands = new Map()
  for (const entry of engine.snapshot().ring) {
    if (entry.tool === 'read') duplicateReads.set(entry.canonicalArgs, (duplicateReads.get(entry.canonicalArgs) ?? 0) + 1)
    if (entry.tool === 'bash' && entry.command !== undefined) {
      duplicateCommands.set(entry.command, (duplicateCommands.get(entry.command) ?? 0) + 1)
    }
  }
  return {
    zeroProgressRounds,
    duplicateReads: [...duplicateReads.values()].filter(count => count > 1).length,
    duplicateCommands: [...duplicateCommands.values()].filter(count => count > 1).length,
  }
}

/** Parse model tool arguments the way the agent loop does: JSON, else the raw string. */
function parseArguments(raw) {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return raw
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

  const runRows = loadPairedRecords(reportsDir)
  const records = loadRunRecords(reportsDir)
  const rows = foldPairs(runRows.length > 0 ? runRows : records)
  console.log(`orcana-dsh analysis: ${runRows.length} paired rows, ${records.length} run records from ${reportsDir}`)
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
