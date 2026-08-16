# Changelog

All notable changes to the Orcana runtime pack (governor line) are documented
here. Format based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-08-16

First stable release of the governor line: `@leooday/governor-core`,
`@leooday/dsh-governor`, `@leooday/dsh-bundle`.

### Added

- **Progress Governor** — fingerprint ring (deep key-sorted canonical args,
  result SHA-256) classifies observations as first-observation / progress /
  new-evidence / repeated; zero-progress rounds aggregate per turn, escalate
  a tiered steer ladder (gentle → re-evaluate → strong with repeated
  pattern), bounded by `maxForcedContinuations`; in-round repeat reminders
  ride `additionalContexts`, coordinated with the base `repeat-tool-reminder`
  (read/bash/search excluded).
- **Evidence Freshness** — workspace generation advances on mutation tools;
  verification commands (first-verb token recognition: npm/pnpm/yarn/npx
  subcommands, segment-scoped patterns, bare testers) record receipts
  (command/resultHash/generation/status/callId); the model-visible snapshot
  flags stale (pre-generation) passes; session-log replay rebuilds identical
  engine state (`ProgressFactEngine.rebuild`).
- **Completion Claim Guard** — three objective rules at `agent/turn-stopping`
  (unverified mutation, failing verification, opt-in unsupported completion
  claim), shared forced-continuation budget with the ladder.
- **Capability Router** — stable core tools (read/write/edit/bash/todo_write)
  plus task profiles (coding / research / minimal), applied via scoped
  `ctx.tools.restrict` before the first model request; unknown names filtered
  against the registry first.
- **Benchmark harness** — paired A/B runner (deterministic seed arm order,
  isolated per-run homes, budgets: 40 calls / 30 min wall / token fuse,
  SIGTERM → grace → SIGKILL authoritative verdicts), independent judge
  (acceptance + false-completion detection), session-log metrics aggregation
  and discipline metrics (zero-progress rounds, duplicate reads/commands),
  three-gate task pipeline (baseline green / reproducer red / official fix
  green) with frozen manifests and re-runnable gate verification.

### Fixed

- `turn.mutation` flag wiring (rounds with mutations are never zero-progress).
- Tier steer text counts the actual chain length under custom thresholds.
- Ring cleanup on generation advance (dead fingerprints no longer shrink the
  effective window).
- `inject: ['tools']` declaration (the router's `ctx.tools` access failed at
  runtime without it).
- `ReplayEvent` shape matches the persisted session log
  (`message.source.callId` + block `toolCallId`/`isError`) — resume rebuilds
  and discipline replay now work on real logs.
- `dsh plugin add` install path verified end-to-end (pnpm-publish workspace
  rewriting, registry metadata/tarball serving, boot to the credential
  sentinel).

### Security / environment

- Benchmark runs strip proxy variables and telemetry/tools modes from the
  run environment; `scripts/bench-run.sh` provides OS-level network
  isolation (user+net namespace, zero default route) and an allowlist model
  proxy for hosts where the provider is only reachable through a proxy.

### Measured (preliminary)

Paired A/B (deepseek-v4-flash): 8 of 11 paired runs used fewer tokens with
the governor active; median negative on every task (demo-format-money,
marked-blank-tab, dayjs-updatelocale). Small samples — see the README
"Measured impact" section for the honest reading.

## [0.1.0-rc.1] - 2026-08-13

First release candidate. P0–P7 development snapshots: progress governor
ring + ladder, verification receipts + freshness snapshot, completion guard
rules, capability router profiles, benchmark harness skeleton. Not yet
registry-installable as a bundle.
