/**
 * Independent judge (P6): applies the manifest's acceptance command to the
 * run's resulting workspace and classifies the outcome. Never the agent,
 * never an LLM — a fixed script (PLAN 5.5/10).
 *
 * Verdict classes:
 * - success: acceptance passed (false completions are exactly the runs
 *   where the agent CLAIMED done but acceptance failed)
 * - false-completion: agent's final text claimed completion but acceptance
 *   failed (the verification-trap signal)
 * - failed: acceptance failed, no completion claim
 * @module orcana-benchmark/judge
 */

import { execFile } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'

/**
 * Completion-claim heuristic over the assistant's final text. Deliberately
 * broad (English + Chinese markers); it only gates the false-completion
 * classification, never the acceptance verdict itself.
 */
export function claimedCompletion(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  const markers = [
    /\b(done|complete|completed|finished|fixed)\b/i,
    /\b(all\s+)?tests?\s+pass/i,
    /(完成|修复完成|通过了|测试通过|搞定)/,
  ]
  return markers.some(marker => marker.test(text))
}

/**
 * The last non-empty assistant text across a run's session logs (zstd) —
 * the judge's completion-claim input, read from the durable log exactly as
 * the governor's rule 3 would see it.
 * @param sessionDir - the run home's `sessions` directory.
 * @returns the final assistant text, or undefined without one.
 */
export function lastClaimText(sessionDir) {
  if (!existsSync(sessionDir)) return undefined
  const texts = []
  for (const ns of readdirSync(sessionDir)) {
    const nsDir = `${sessionDir}/${ns}`
    if (!existsSync(nsDir)) continue
    for (const session of readdirSync(nsDir)) {
      const log = `${nsDir}/${session}/session.jsonl.zstd`
      if (!existsSync(log)) continue
      const text = execFileSync('zstd', ['-dc', log], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of text.split('\n')) {
        let event
        try { event = JSON.parse(line.trim()) } catch { continue }
        if (event?.type !== 'assistant/message') continue
        const content = event.data?.message?.content ?? []
        const joined = content
          .filter(block => block?.type === 'text')
          .map(block => block.text)
          .join('\n')
        if (joined.trim().length > 0) texts.push(joined)
      }
    }
  }
  return texts.length > 0 ? texts[texts.length - 1] : undefined
}

/**
 * Run the acceptance command in the workspace.
 * @param command - shell command from the manifest's verification.acceptance.
 * @param workspace - the workspace directory to run in.
 * @param timeoutMs - hard timeout; timeout itself is a fail (no exit marker).
 * @returns { passed: boolean, timedOut: boolean, exitCode: number | null, output: string }
 */
export function runAcceptance(command, workspace, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], {
      cwd: workspace,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const timedOut = error?.killed === true && error?.signal === 'SIGTERM'
      const passed = error === null
      resolve({ passed, timedOut, exitCode: error?.code ?? 0, output: `${stdout}\n${stderr}`.trim() })
    })
  })
}

/**
 * Classify the judge verdict for one run.
 * @param acceptance - { passed, timedOut }.
 * @param claimed - whether the agent's final text claimed completion.
 * @returns { verdict: 'success' | 'false-completion' | 'failed', reason }.
 */
export function judgeVerdict({ passed, timedOut }, claimed) {
  if (passed) return { verdict: 'success', reason: 'acceptance_passed' }
  if (timedOut) return { verdict: 'failed', reason: 'acceptance_timeout' }
  if (claimed) return { verdict: 'false-completion', reason: 'claimed_but_acceptance_failed' }
  return { verdict: 'failed', reason: 'acceptance_failed' }
}
