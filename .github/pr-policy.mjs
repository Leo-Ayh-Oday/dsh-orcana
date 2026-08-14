#!/usr/bin/env node
/**
 * Lightweight PR label policy for orcana-dsh — a trimmed port of the
 * upstream validatePullRequest contract (kind/* exactly one, area/* at least
 * one, unknown and legacy kind values rejected). The full upstream
 * issue-management machinery (ProjectV2 lifecycle) is out of v0.1 scope.
 */
import process from 'node:process'
import fs from 'node:fs'

const PR_KINDS = new Set([
  'kind/feature',
  'kind/bug-fix',
  'kind/doc',
  'kind/testing',
  'kind/cleanup',
  'kind/dependency',
])
// Retired aliases stay reserved so they cannot be recreated.
const LEGACY_LABELS = new Set([
  'kind/bug',
  'kind/documentation',
  'feature',
  'bug-fix',
  'doc',
  'cleanup',
  'testing',
  'dependencies',
  'ci',
  'cli',
  'llm',
  'web-search',
])

export function validatePullRequest(labels, { isDraft, authorType }) {
  const automated = authorType === 'Bot' || authorType === 'App'
  if (isDraft || automated) return []
  const kinds = labels.filter((label) => PR_KINDS.has(label))
  const unknownKinds = labels.filter(
    (label) => label.startsWith('kind/') && !PR_KINDS.has(label) && !LEGACY_LABELS.has(label),
  )
  const legacyLabels = labels.filter((label) => LEGACY_LABELS.has(label))
  const sourceLabels = labels.filter((label) => label.startsWith('source/'))
  const areas = labels.filter((label) => label.startsWith('area/'))
  const errors = []
  if (kinds.length !== 1) errors.push('PR 必须恰好有一个允许的 kind/*，当前为 ' + kinds.length)
  if (unknownKinds.length > 0) errors.push('PR 含不支持的 kind/*：' + unknownKinds.join(', '))
  if (legacyLabels.length > 0) errors.push('PR 含旧版标签：' + legacyLabels.join(', '))
  if (sourceLabels.length > 0) errors.push('source/* 仅用于 Issue：' + sourceLabels.join(', '))
  if (areas.length === 0) errors.push('PR 必须至少有一个 area/*')
  return errors
}

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
const pull = event.pull_request
const errors = validatePullRequest(
  (pull.labels ?? []).map((label) => label.name),
  { isDraft: pull.draft === true, authorType: pull.user?.type ?? 'User' },
)
for (const error of errors) process.stdout.write('::error::' + error + '\n')
if (errors.length > 0) {
  process.stderr.write('PR label policy 未通过，共 ' + errors.length + ' 项\n')
  process.exit(1)
}
process.stdout.write('PR label policy 通过。\n')
