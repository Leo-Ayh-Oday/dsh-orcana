# R0-A Recovery State Inventory

Factual audit only. This report records what IS, not what should be. No
production source, test, or existing doc was modified.

## Baseline

- Branch: `research/durable-recovery-r0-a`
- Starting HEAD: `f8a45cd10568dd2a457cd14f4b23629dac3dc690`
  (`codex/linux-r5-native-evidence-fix` tip = `1299c5d` + `fix(linux): restore
  compilable absent-schema defaults`; `packages/governor-core`,
  `packages/dsh-governor`, and `docs/` are byte-identical between this tip and
  `origin/main` @ `3754220`, so every observation below holds for main too)
- Worktree clean at audit start (`git status --short` empty)
- Audit performed in a dedicated git worktree
  (`/home/fuqiang/worktrees/dsh-orcana-r0a`) because another session was
  actively using the primary checkout; no shared-state interference.

## Current Architecture Map

Two packages, one direction of dependency:

```
governor-core/src/index.ts   (743 lines, pure; imports only node:crypto)
  - ProgressFactEngine (class)          — the ONLY mutable Orcana runtime state holder
  - classifyObservation / receiptStatus — pure classifiers
  - steerText / render*                 — stable model-visible strings
        ↑ EngineEvent (sole input currency)
dsh-governor/src/index.ts    (556 lines, Cordis plugin)
  - toEngineEvent        — the ONE DSH→core translation (used by BOTH paths)
  - apply(ctx, config)   — wires 4 listeners + 1 inject:
      tools/post-execute     → live observation (applyEvent)
      agent/pre-step         → user-interjection reset (resetChains, forced delete)
      agent/turn-stopping    → round settle (endTurn), ladder steer, completion guard
      agent/session-start    → resume/compact REBUILD (rebuild ∘ translateSessionEvents)
      ctx.inject systemPrompt→ verification-state rendering (snapshot() read-only)
      agent/created          → capability router restrict (P5)
```

DSH extension points consumed (docs/architecture.md table matches code except
one stale line — see Candidate Gaps): `tools/post-execute` (waterfall),
`agent/pre-step`, `agent/turn-stopping`, `agent/created`, `agent/session-start`,
`ctx.tools.restrict`, `systemPrompt.context`, `agent.steer()`.

Durability substrate: the DSH session log itself — append-only zstd JSONL
(`~/.dsh/sessions/**/session.jsonl.zstd`), event types verified against real
logs and `@deepseek-ai/dsh-session@0.1.0-rc.6/lib/types/types.d.ts`
(`SessionEventMap`: `tool/call` `{turn, step, callId, name, arguments:string}`,
`tool/result` `{message: ToolResultMessage, error?, meta?}`, plus
`assistant/message`, `user/message`, `turn/start|end`, `step/start|end`,
`request/*`, `session/end-seed`, …). Orcana keeps **no second log**: nothing in
either package imports `node:fs` or any storage API (verified by grep).

## Live Event Path

Construction site: the `tools/post-execute` waterfall listener
(`packages/dsh-governor/src/index.ts`, `apply()`).

1. DSH `ToolRuntime.execute` pipeline reaches `postExecute()`
   (`dsh-tools/lib/index.js:3359`): `ctx.waterfall(..., "tools/post-execute",
   exec, result, next)` where
   - `exec: ToolExecution` = `{callId, rootCallId?, name, arguments: unknown
     (parsed, lossless-JSON contract), agent?, parent?, ...}` (dsh-tools types
     index.d.ts:196–211),
   - `result: ToolExecutionResult` = success `{isError:false,...}` | failure
     `{isError:true,...}` with required `content: ContentBlock[]`.
2. Governor listener runs BEFORE `await next()`:
   `engine.applyEvent(toEngineEvent(exec, result))`, then
   `engine.consumeInlineReminder()` rides `additionalContexts`.
3. `toEngineEvent` derives every EngineEvent field from `(exec, result)`:
   `command` via `shellCommand` (bash-only, background acks excluded),
   `resultHash = sha256(JSON.stringify(result.content))`,
   `exitCode/interrupted` via `shellExitStatus` regex over the RENDERED text
   markers, `mutation = MUTATION_TOOLS.has(name) && !isError`.

Key properties measured in code:

- The engine is created lazily on first observation (`engineFor`) and keyed in
  a `WeakMap<Agent, …>` — process-lifetime only.
- `postExecute` fires for nested/code-mode sub-dispatches as well (scheduler
  `finalizeScheduledExecution` handles dispatched executions,
  dsh-tools index.js:2999, 3223–3225).
- A scheduler `final-result` outcome BYPASSES post-execute entirely
  (dsh-tools index.d.ts:301–303 "a final-result bypasses it"; index.js:3186
  "pipeline failures are already final") — those outcomes are never observed
  by the live path.
- Downstream waterfall listeners may REPLACE `content` or `block` the result;
  the governor has already hashed the PRE-decision content by then.

## Replay Event Path

Construction site: `agent/session-start` listener, `source === 'resume' |
'compact'` only (`SessionStartSource = 'startup' | 'resume' | 'clear' |
'compact'`, dsh-agent runtime-types.d.ts:58).

1. `sessionReplayEvents(agent.session.events)` — keeps only `tool/call` and
   `tool/result`, in log order.
2. `translateSessionEvents` pairs each `tool/result` with its pending
   `tool/call` via `callId = message.source.callId ?? block.callId ??
   block.toolCallId`; orphan results (pruned/crashed tails) are skipped.
3. `arguments` is the RAW JSON string in the log (verified in a real session
   log and in SessionEventMap docs: "raw `arguments` JSON string exactly as
   the model produced it (unparsed)"); `parseArguments` does
   `JSON.parse` else raw-string fallback — deliberately mirroring the agent
   loop.
4. Each paired event goes through THE SAME `toEngineEvent`, then
   `ProgressFactEngine.rebuild(events)` = fresh engine + N × `applyEvent`.
5. `engines.set(agent, rebuilt)`; `forced.delete(agent)`.

The pairing shape was FIXED after an audit finding (PLAN §11.x item: the
original fixture assumed `content[0].callId`; real logs carry
`message.source.callId` — orphan rate was 100% before the fix). Verified
against a real log today: `tool/result.data.message.source =
{kind:'tool', callId:'call_00_…'}`, block
`{type:'tool-result', toolCallId, isError:true|false}` — matches the fixed
model.

### live == replay: field-by-field

| Field | Live source | Replay source | Verdict |
| --- | --- | --- | --- |
| callId | `exec.callId` (CallId) | `message.source.callId` (+ legacy fallbacks) | SAME identity, real-log verified |
| tool | `exec.name` | `tool/call.data.name` | SAME |
| canonicalArgs | `canonicalizeArgs(parsed args)` — live args are parsed objects per `ToolExecutionInput.arguments` contract ("losslessly JSON-serializable") | `canonicalizeArgs(parseArguments(raw string))` | SAME under the lossless-JSON domain (JSON round-trip). Edge: malformed-JSON fallback yields `JSON.stringify(rawString)` — replay-side only |
| command | `shellCommand(tool, args)`, bash-only, `run_in_background===true → undefined` | identical function, same inputs | SAME derivation |
| resultHash | `sha256(JSON.stringify(result.content))` of PRE-waterfall-decision content | hash of PERSISTED block content (post-decision, post-compaction) | **CAN DIFFER** (see below) |
| isError | `result.isError` — REQUIRED discriminator live | `block.isError ?? false` — OPTIONAL in `ToolResultBlock` type | SAME when present (real logs show it); silent false-default if absent |
| mutation | `MUTATION_TOOLS.has(name) && !isError` | identical derivation | SAME |
| exitCode / interrupted | `shellExitStatus(rendered text)` — `[exit code: N]` / `[killed by signal: X]` / `[timed out after` markers | same parser over persisted text; marker contract owned by dsh-shell renderers (confirmed in `dsh-shell/lib/index.js:32–37`) | SAME provided markers survive verbatim in the log (they do — they are part of the rendered content) |

Live-only information (present live, absent from the replay feed):

1. Nested sub-dispatch observations: post-execute fires for them live, but
   their durable records are `tool/code-dispatch-start` / `tool/code-dispatch`
   events (counted in a real log: 48 code-dispatch vs 32 tool/call in one
   session), which `sessionReplayEvents` FILTERS OUT. A code-mode-heavy run
   rebuilds with fewer events than live observed.
2. `rootCallId` / parent-token nesting — not modeled in `EngineEvent` at all.
3. In-memory ordering nuances of the active batch FIFO — none observable in
   the event stream itself.

Replay-only events: pipeline failures that bypassed post-execute (`final-result`)
still materialize into logged `tool/result` events → the rebuilt engine sees
observations the live engine NEVER processed.

Event ordering: replay preserves log order = completion order of root calls;
no reordering found. Duplicate/missing/partial semantics: missing (orphan)
results are skipped silently; DUPLICATE `tool/result` events for one callId
are NOT deduplicated — `translateSessionEvents` never removes the pending
entry, so a duplicated log record would be applied TWICE (live cannot produce
this; no guard exists either way).

Documented-and-intended divergence: compaction rewrites `tool/result` content;
the code comment and PLAN §“compaction 交互” declare the CURRENT log
authoritative and accept post-compact hash drift vs live-era hashes. This is a
real semantic difference between what live classified and what replay
reconstructs for the same logical run.

## State Inventory

Orcana-side runtime state (all of it lives in two containers: the engine class
and two adapter WeakMaps):

| State / Fact | Defined at | Written by | Read by | Current lifetime | Evidence |
| --- | --- | --- | --- | --- | --- |
| `generation` | governor-core `ProgressFactEngine` private field (=0 initial) | `onMutation()`, `applyEvent` on `event.mutation` | `currentGeneration()` → evidence render, completion guard, `classifyObservation`, `isStale` | per engine instance (process) | src/index.ts:249–258, 287–300 |
| Fingerprint ring (`ring: RingEntry[]`, window default 8) | engine private | `applyEvent` push/shift; mutation prune (drops non-current-gen entries) | `classifyObservation`, `snapshot()` | per engine; sliding window | src/index.ts:250, 290–296, 302–306 |
| Verification receipts (`Map<command, Receipt>`, latest-wins) | engine private | `recordReceipt` via `applyEvent` (verification commands only); public `recordReceipt` | `receiptFor`, `isStale`, `snapshot().receipts` → `renderVerificationState` (system-prompt context) + `completionViolations` | per engine | src/index.ts:251, 308–318, 466–473 |
| Zero-progress chain (`chain`) | engine private | `endTurn` (+1/−0), `resetChains` (=0) | `zeroProgressChain`, `endTurn` verdict → `decideSteer` thresholds | per engine; **never snapshotted, never rebuilt** | src/index.ts:252, 371–396, 400–404 |
| Turn-local round state (`TurnState`: observations/mutation/significant/verifyNew/verifyPass/inlineStreak/inlineFingerprint/inlineReminder/inlineReminderFired/repeatedPattern) | engine private `this.turn` | `observeTurn` (lazy `newTurnState`), cleared by `beginTurn`/`endTurn`/`resetChains` | `consumeInlineReminder`, `endTurn` | one round; code comments "transient; never snapshotted" | src/index.ts:255, 320–369, 508–525 |
| Inline-repeat reminder (armed-once flag + text) | inside `TurnState` | `observeTurn` (threshold 2) | adapter `consumeInlineReminder` right after `applyEvent` in post-execute | one round | src/index.ts:346–360; dsh-governor src post-execute handler |
| Forced-continuation counter (`forced: WeakMap<Agent,number>`) | dsh-governor `apply()` closure | turn-stopping ladder steer & completion-guard steer (`+1`); `agent/pre-step` user-source (`delete`); session-start resume (`delete`) | `decideSteer` maxForced check; completion-guard budget check | per Agent object, process only | dsh-governor src/index.ts:337–338, 443–445, 486–497, 500–531 |
| Per-agent engine registry (`engines: WeakMap<Agent,ProgressFactEngine>`) | dsh-governor `apply()` closure | `engineFor` lazy-create; session-start `engines.set(rebuilt)` | post-execute, systemPrompt inject, turn-stopping, pre-step reset | per Agent object (GC-coupled) | dsh-governor src/index.ts:336, 340–347, 415–430 |
| Completion-guard evaluation state | derived per call: `{generation, receipts}` + `lastAssistantText(session)` | assembled at turn-stopping | `completionViolations` → `renderCompletionSteer` → `agent.steer` | transient per stop boundary | dsh-governor src/index.ts:517–531; core src 604–640 |
| Capability-router restriction | DSH tools service (agent scope), applied once at `agent/created` via `ctx.tools.restrict({allow})` | router listener | DSH tool resolution | agent scope lifecycle (disposer unwinds); config-driven, no governor-side memory | dsh-governor src/index.ts:432–450 |
| Plugin lifecycle (listeners, inject, effect disposal) | cordis ctx | `apply()` registrations | cordis dispatch | plugin context lifetime | dsh-governor src/index.ts:333, 534–536 |
| Config (thresholds, patterns, modes, budgets) | `Config` zod schema + `dsh-bundle/cordis.patch.yml` row | mount-time validation | every policy decision | process/mount | dsh-governor src/index.ts:96–152; bundle patch yml |

DSH-native state that Orcana reads but does not own:

| Fact | Where | Used for |
| --- | --- | --- |
| `tool/call` {callId, name, arguments(raw string)} | session log (append-only, zstd JSONL) | replay pairing; verification/mutation identity |
| `tool/result` {message.source.callId, block.content, block.isError} | session log | replay hashing; isError; exit markers inside rendered text |
| `assistant/message` texts | session log | rule-3 claim text (`lastAssistantText` backward scan) |
| `user/message` source kinds ('user' vs 'plugin') | session log / inbox | interjection reset predicate at pre-step |
| `turn/end` reason incl. `'interrupted'` (crash-tolerant marker) | session log | NOT consumed by Orcana today |
| shell exit-status markers (`[exit code: N]`, `[killed by signal: X]`) | rendered tool-result text (owned by dsh-shell renderers) | receipt pass/fail/unknown |
| `session/end-seed`, compaction brackets, request headers | session log | not consumed by Orcana |

World state (outside both Orcana and the session log): the filesystem/git tree
being mutated by `write`/`edit` tools, external processes/services invoked by
`bash`, background shells still running at crash time, and any side effect
whose tool/result never reached the log. Orcana's generation counter is a
LOCAL OPINION about this world, advanced only by successful mutation-tool
returns; it can drift from reality (e.g., a failed-but-partially-effective
command advances nothing, a successful `write` to a throwaway path advances
generation regardless).

## EngineSnapshot Reality

`EngineSnapshot = {generation, ring[], receipts[]}` — audited by tracing every
creation/read/write site:

- **Created by** `ProgressFactEngine.snapshot()` at exactly three kinds of
  sites: (a) dsh-governor `systemPrompt.context` renderer (src/index.ts:426) —
  reads `.receipts` only; (b) dsh-governor completion guard (src/index.ts:529)
  — reads `.receipts` only; (c) tests (core.spec.ts:121,216,227–228,245;
  p3.spec.ts:73; adapter.spec.ts:120,176).
- **Saved by**: NOTHING. Neither package imports node:fs or any store; no
  file/db/session writes exist. `git grep` over both sources confirms zero
  persistence calls.
- **Read back by `restore()`**: TESTS ONLY (core.spec.ts:227–228). No
  production caller exists anywhere in the repo.
- Therefore, despite the doc comment "Durable engine state — resume replays
  the session log into this", `EngineSnapshot` is in fact: an **in-memory read
  model** (receipts view for rendering/guarding) plus a **serialization/test
  contract** proving rebuild equivalence. The actual resume mechanism is
  `ProgressFactEngine.rebuild(translateSessionEvents(...))` — snapshot is not
  part of it. No second truth store exists; there is exactly one durable truth
  (the session log) and one derived reconstruction path (rebuild).

Corollary: `restore()` is currently dead production surface (exported, tested,
unwired). `beginTurn()` is likewise exported but called by NOBODY — rounds are
actually delimited by `endTurn` clearing `this.turn` itself and the next
observation lazily recreating it.

## Existing Recovery Capability

What a resume (`agent/session-start`, source `resume`/`compact`) actually
recovers today:

| Capability | Verdict | Evidence |
| --- | --- | --- |
| Rebuild `generation` from session log | **SUPPORTED** | mutations derive from logged tool names + isError; rebuild replays them identically (adapter.spec.ts:139–143 asserts gen 1) |
| Rebuild verification receipts | **SUPPORTED** | recomputed through the same `applyEvent`; statuses/generations/commands consistent (adapter.spec.ts:113–143, 168–176) |
| Preserve receipt freshness semantics | **SUPPORTED** | `isStale` compares rebuilt receipt.generation vs rebuilt generation; STALE flag renders off rebuilt state (p3.spec.ts STALE cases) |
| Stale-evidence steering recovers naturally | **SUPPORTED** | evidence freshness + guard operate purely on rebuilt state + durable lastAssistantText |
| Rebuild fingerprint ring | **PARTIAL** — structure/window semantics recover; individual `resultHash`es can drift whenever compaction rewrote result text or a live post-execute listener replaced content, so repeat/new-evidence classifications after resume may legitimately differ from what live concluded. Code declares current-log authoritative (intended) |
| Keep receipt `resultHash` faithful | **PARTIAL** — same drift applies to the informational hash stored in receipts |
| Rebuild zero-progress chain | **NOT_SUPPORTED** (by design) — `chain` is not in `EngineSnapshot`; `rebuild` starts at 0; PLAN §"链不进 snapshot" documents restart-from-zero as conservative |
| Recover turn-local state / inline reminder | **NOT_SUPPORTED** (by design) — "transient; never snapshotted"; first post-resume round starts empty |
| Recover forced-continuation budget | **NOT_SUPPORTED** — `forced.delete(agent)` at session-start; note the raw material EXISTS in the log (steers are logged plugin-source `user/message`s with summary strings) but nothing counts them back |
| Recover completion-guard readiness | **SUPPORTED** — needs generation+receipts (rebuilt) and last assistant text (read from durable log, backward scan) |
| Router/profile state recovery | **N/A-as-state** — restriction is config-driven, re-applied per agent at `agent/created`; whether that event fires for resumed agents is a harness behavior this repo cannot prove (see Unknowns) |
| Reconstruct interrupted/unknown outcomes | **SUPPORTED** — `[timed out after`/`[killed by signal: X]` markers persist in rendered text; `receiptStatus` maps them to `'unknown'` (core.spec.ts receiptStatus cases; dsh-shell owns the format) |
| Resume wiring itself | **SUPPORTED in code, thin tests** — the `agent/session-start` listener exists (H1 fixed per PLAN §11.x) but there is NO behavior-level test driving `ctx.emit('agent/session-start', {source:'resume'})` through `apply()`; coverage is at the pure-function layer only |

## State Outside ProgressFactEngine

Adapter-owned: `engines` WeakMap, `forced` WeakMap (both above). Nothing else
mutable exists in dsh-governor — no timers, caches, or module-level lets.

Plugin-ecosystem state worth naming: the repeat-tool-reminder coordination
mentioned in configs (`inlineRepeatTools` aligned with its exclude list) is a
SEPARATE plugin whose state is not visible here; Orcana only aligns constants.

Benchmark replay (`benchmark/runner/analyze.mjs disciplineMetrics`)
REIMPLEMENTS the pairing loop inline instead of calling
`translateSessionEvents`, adds `step/end` as an extra round boundary, and
passes `isError: block.isError` without the `?? false` default. Functional
today; a second copy of the translation contract that can drift.

## Native DSH Facts Observed

Verified against `@deepseek-ai/{dsh-session,dsh-llm,dsh-tools,dsh-agent}@0.1.0-rc.6`
type definitions AND a real `session.jsonl.zstd`:

- Append-only durable log; `Session.append` runtime-validates JSON-ness;
  `turn/end` carries a crash-tolerant `'interrupted'` reason ("events recorded
  before the crash remain intact").
- `tool/call.arguments` = raw unparsed JSON string; `ToolExecutionInput.arguments`
  = parsed lossless JSON — the roundtrip is contract-safe.
- `ToolResultMessage.content` is a SINGLE-block tuple `[ToolResultBlock]`;
  `source = {kind:'tool', callId}` is required; `isError?: boolean` optional.
- Exit-status markers are a dsh-shell-owned rendering contract, mirrored (not
  owned) by the governor's regexes; degradation mode is documented in-code
  (unknown markers read as clean exit 0).
- `SessionStartSource` includes `'clear'` — Orcana's listener ignores it (only
  resume/compact trigger rebuild), so a cleared session would keep a STALE
  cached engine for that Agent object.
- Checkpoint/durability policy belongs to `dsh-session-checkpoint-policy`
  (referenced by SessionEventMap docs); Orcana has zero involvement — it
  neither forces nor observes checkpoints.

## World State Boundaries

Not Orcana state, and not reconstructed by anything here: actual workspace
content (git/filesystem), running background processes, external services,
clock/wall-time, environment variables, and the model provider session.
Orcana's only linkage to this world is the generation counter (advanced by
mutation-tool successes) — an intentionally coarse proxy, not a fact about the
world. Benchmark methodology invariant 4 assigns durability semantics
(checkpoints before model requests/side effects) to the harness level, not to
Orcana.

## Unknowns

1. Whether `agent/created` (and thus the router `restrict`) fires again for a
   resumed agent instance — determined by the uninstalled harness core, not by
   any package available here.
2. Exact flush timing of the durable log relative to `tools/post-execute`
   (checkpoint-policy ownership lives in `dsh-session-checkpoint-policy`);
   i.e., how much tail can a crash lose between live observation and durable
   record. The `turn/end` 'interrupted' marker proves prefix survival, not
   suffix completeness.
3. Whether any deployed DSH plugin stack actually replaces content/block at
   post-execute AFTER the governor in practice (divergence #1 is conditional
   on it; the mechanism is proven in dsh-tools, its frequency is not).
4. Whether duplicate `tool/result` events ever occur in real logs (the replay
   translator would double-count them; no sample was found in the logs
   inspected).
5. Whether `run_in_background` completions produce a second observable result
   event later (background acks are excluded from verification identity by
   design; their eventual exit status is invisible to the engine today).

## Candidate Gaps

Factual gaps only — no fix design:

1. `docs/architecture.md` still claims adapter-side resume wiring "is pending
   (H1)" while the listener shipped; the doc understates current capability.
2. Zero-progress chain and forced-continuation budget are unrecovered on
   resume; the latter's raw evidence (logged plugin steers) exists but is
   unused.
3. `translateSessionEvents` does not deduplicate repeated results for one
   callId and does not consume pending entries.
4. `session-start` source `'clear'` leaves a stale engine cached.
5. Code-mode sub-dispatches are live-observed but replay-filtered
   (`tool/code-dispatch*` events ignored); conversely post-execute-bypassing
   pipeline failures are replay-visible but never live-observed. Both are
   structural live↔replay asymmetries around the shared-transition claim.
6. `EngineSnapshot.restore()` and `beginTurn()` are exported production
   surface with zero production callers.
7. `benchmark/runner/analyze.mjs` maintains a second, slightly divergent copy
   of the replay pairing (extra step/end boundaries; missing `?? false` on
   isError).
8. Ring/receipt `resultHash` drift after compaction is accepted by design;
   its downstream effect on post-resume classification has no test.

## Evidence Index

| Conclusion | path | symbol / lines |
| --- | --- | --- |
| Single transition path claim | packages/governor-core/src/index.ts | `applyEvent` (~283–318), header P1 note |
| Engine private states | packages/governor-core/src/index.ts | `ProgressFactEngine` fields 249–256 |
| Chain not in snapshot; turn transient | packages/governor-core/src/index.ts | `EngineSnapshot` 117–122; `TurnState` comment 508–509; `endTurn` 379–396 |
| rebuild = fresh engine + applyEvent | packages/governor-core/src/index.ts | `static rebuild` 552–557 |
| snapshot()/restore() callers | repo-wide grep | tests only: core.spec.ts:227–228, p3.spec.ts:73; prod reads at dsh-governor src/index.ts:426, 529 |
| Live construction | packages/dsh-governor/src/index.ts | `toEngineEvent` 213–237; post-execute listener ~452–475 |
| Replay construction | packages/dsh-governor/src/index.ts | `ReplayEvent` 243–256; `sessionReplayEvents` 268–280; `translateSessionEvents` 282–310 |
| Resume wiring + forced reset | packages/dsh-governor/src/index.ts | `agent/session-start` handler ~410–430 |
| forced budget semantics | packages/dsh-governor/src/index.ts | `forced` WeakMap 338; pre-step reset ~480–489; turn-stopping consumption 486–531 |
| Mutation tool set / shell tool set | packages/dsh-governor/src/index.ts | `MUTATION_TOOLS`/`SHELL_TOOLS` 155–162 |
| Exit-marker contract owner | node_modules @deepseek-ai/dsh-shell lib/index.js | lines 13–14, 32–37 |
| post-execute waterfall + replace/block | node_modules @deepseek-ai/dsh-tools lib/index.js | `postExecute` 3359–3388 |
| final-result bypasses post-execute | node_modules @deepseek-ai/dsh-tools lib/types/index.d.ts | 301–303, 121–124 |
| Sub-dispatch logging as code-dispatch | node_modules @deepseek-ai/dsh-tools lib/types/index.d.ts | `tools/code-dispatch-log` 62–75; real log: 48 `tool/code-dispatch` events |
| SessionEventMap shapes | node_modules @deepseek-ai/dsh-session lib/types/types.d.ts | 223–354; `arguments` raw string 283–290; interrupted turn-end 162–166 |
| ToolResultMessage/source/isError optionality | node_modules @deepseek-ai/dsh-llm lib/types/{message,types}.d.ts | message.d.ts:22–25, 140–144, 185–189; types.d.ts:69–74 |
| SessionStartSource incl. 'clear' | node_modules @deepseek-ai/dsh-agent lib/types/runtime-types.d.ts | 57–58 |
| Real-log verification | ~/.dsh/sessions/--home-fuqiang-projects-pcba--/3f326596-…/session.jsonl.zstd | `tool/result` = `{error?, message{source{kind:'tool',callId}}, turn, step}`; block `{type:'tool-result', toolCallId, isError}` |
| live≡replay pinned by synthetic fixtures | packages/dsh-governor/tests/adapter.spec.ts | 105–143, 168–176; packages/governor-core/tests/core.spec.ts 232–246 |
| No behavior test for session-start resume | packages/dsh-governor/tests/apply.spec.ts | covers post-execute/pre-step/turn-stopping/created only |
| Stale architecture doc | docs/architecture.md | Durability/replay row + "No second log" invariant ("pending — H1") |
| Second replay implementation | benchmark/runner/analyze.mjs | `disciplineMetrics` 169–226 |
| Chain restart documented as intended | PLAN-v0.1.md | §“快照/恢复”(449), §“链不进 snapshot”(459), compaction authority (127), ReplayEvent fix history (581) |
| No fs/db writes in Orcana | grep over both src files | imports: node:crypto (core); cordis/schemastery/dsh types (adapter) |

## R0-A Verdict

R0_A_COMPLETE

Scope honesty: complete for everything reachable in this repository plus the
pinned rc.6 DSH packages installed in its workspace; five items remain
UNKNOWN (listed above) because they are decided inside the harness core /
runtime deployment, not in any source available here. None of them blocked
establishing the inventory, the live/replay field mapping, or the
EngineSnapshot reality.
