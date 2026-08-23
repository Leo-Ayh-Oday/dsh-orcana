# R0-A Recovery State Inventory (Rev.2)

Factual audit only: what exists, what reads it, what writes it, what rebuild
currently does, what it currently misses, what remains unknown. Not a
correctness contract, not an R0-B classification, not an R1 design.

Rev.2 corrects overstatements found by independent review of Rev.1
(`b10f694`): the "single mutable state holder" and "sole input currency"
framing, a WRONG turn-local-state recovery verdict (rebuild actually leaves a
populated TurnState — runtime-proven below), an unproven "cannot drift by
construction" claim, code-mode divergence that was acknowledged in one section
but not propagated into capability verdicts, and several SUPPORTED claims that
only held for a narrower scope than stated.

## Baseline

- Branch: `research/durable-recovery-r0-a`
- Starting HEAD for this revision: `b10f694bf6869ffc00f8e5056685d73177e33828`
- Prior-revision starting HEAD: `f8a45cd10568dd2a457cd14f4b23629dac3dc690`
  (`packages/governor-core`, `packages/dsh-governor`, `docs/` are
  byte-identical between `f8a45cd` and `origin/main@3754220`, so source-level
  observations hold for main as well)
- Only file changed by either revision:
  `docs/recovery/R0-A-RECOVERY-STATE-INVENTORY.md`
- Lockfile (`pnpm-lock.yaml`) pins all audited DSH packages to
  **0.1.0-rc.6**; DSH semantics cited below were verified against the rc.6
  artifacts installed in this workspace AND the harness monorepo's rc.6
  release commit (`deepseek-harness@15148dbd9a`, tag lineage
  `release/dsh-0.1.0-rc.6`). Where this checkout has moved to rc.7, rc.6 was
  read via `git show 15148dbd9a:<path>`.
- Input gap: `/DSH/Architecture/ORCANA-DURABLE-EXECUTION-EVIDENCE-RECOVERY-MASTER-PLAN-v0.1.md`
  does not exist on this machine (searched `/DSH`, `$HOME`, worktrees). The
  revision principles quoted in the task directive (Model-First,
  Runtime-Verified; Minimum Necessary Governance; Persist facts, not
  decisions) were applied as stated; Master-Plan-specific cross-references
  could not be re-verified and are flagged where relevant.
- Audit method note: every load-bearing behavioral claim below was either read
  directly from locked-version source or reproduced at runtime with
  `node --experimental-strip-types` against the real engine source
  (`/tmp/r0a-experiment*.mts`, commands in Evidence Index). No claim rests on
  comments alone.

## Current Architecture Map

Two packages, one dependency direction:

```
governor-core/src/index.ts (743 lines, imports only node:crypto)
  ProgressFactEngine          — per-agent mutable fact state (fields below)
    applyEvent / observeTurn / endTurn / beginTurn / resetChains
    snapshot / restore / static rebuild
  classifyObservation, receiptStatus, render*, steer* — pure functions
        ↑ EngineEvent — unified input of the TOOL-OBSERVATION path ONLY
dsh-governor/src/index.ts (556 lines, Cordis plugin)
  toEngineEvent            — the one DSH→core translation (shared by both paths)
  apply(ctx, config):
    engines: WeakMap<Agent, ProgressFactEngine>   ← adapter-local mutable state
    forced:  WeakMap<Agent, number>               ← adapter-local mutable state
    listeners:
      tools/post-execute   → live observation → applyEvent (+ consumeInlineReminder)
      agent/pre-step       → user-source interjection → engine.resetChains() + forced.delete
      agent/turn-stopping  → endTurn settle → ladder steer | completion guard steer
      agent/session-start  → source==='resume'|'compact' → rebuild(translate(...)) + forced.delete
      agent/created        → router restrict({allow}) via ctx.tools.restrict
      ctx.inject systemPrompt → verification-state rendering (snapshot().receipts read-only)
```

Mutable Orcana runtime state lives in TWO containers plus lifecycle/config
state owned elsewhere:

1. governor-core per-engine private fields (below);
2. dsh-governor adapter-local `engines` / `forced` WeakMaps;
3. the tool restriction installed into DSH's tools service at `agent/created`
   (owned and disposed by the agent scope, config-driven — no
   governor-side memory);
4. plugin listener registrations themselves (Cordis lifecycle).

Non-EngineEvent state transitions exist and are part of the runtime contract:
`endTurn()` (chain advance/reset), `resetChains()` (chain+turn clear),
`beginTurn()` (exported, currently called by nobody), `forced` WeakMap writes/
deletes, `engines.set/delete`, and the router restriction install/dispose.
`EngineEvent` is therefore the unified input of the tool-observation path —
NOT the sole input currency of the whole runtime.

Durability substrate: the DSH session log (append-only zstd JSONL). Neither
Orcana package imports `node:fs` or any storage API (grep-verified).

## Live Event Path

Construction site: the `tools/post-execute` waterfall listener
(dsh-governor src/index.ts:460).

1. Locked rc.6 pipeline (`@deepseek-ai/dsh-tools/lib/index.js`): scheduler →
   `completeScheduledExecution` (2997–3004) → `finalizeScheduledExecution`
   (3223) → `postExecute` (3359) → waterfall `"tools/post-execute"` with
   `(exec: ToolExecution, result: ToolExecutionResult)`.
2. The governor folds BEFORE calling `next()`: `applyEvent(toEngineEvent(exec,
   result))`, then `consumeInlineReminder()` rides `additionalContexts`.
3. Field derivation (toEngineEvent, src/index.ts:206–236): bash-only
   `command` (background acks excluded); `resultHash =
   sha256(JSON.stringify(result.content))`; `exitCode/interrupted` parsed from
   rendered-text markers; `mutation = MUTATION_TOOLS.has(name) && !isError`.

Live-path facts measured in locked rc.6 code:

- `MUTATION_TOOLS = {write, edit, str_replace_editor}` (src/index.ts:158).
  `bash` is NOT a mutation tool regardless of effect.
- Nested code-mode sub-dispatches ARE observed live: the `run_code` bridge
  schedules nested executions through the same registry path ("Programs call
  the registry's agent-visible tools through nested executions scheduled under
  the native concurrency contract", dsh-tools lib/index.js:884–891;
  `createExecution` preserves the INNER tool name and sets `parent`,
  index.js:3008–3029; nested bypasses collapse, index.js:2880–2891), and their
  outcomes traverse the same `finalizeScheduledExecution → postExecute`
  waterfall (index.js:2999, 3223–3225). So a nested `write` reaches the
  governor with `exec.name === 'write'`, `mutation === true`.
- Scheduler `final-result` outcomes BYPASS post-execute entirely
  (dsh-tools lib/index.js:3002 + types/index.d.ts:301–303 "a final-result
  bypasses it") — never observed live.
- Downstream waterfall listeners may replace content or block after the
  governor already folded (`postExecute`, index.js:3359–3388: decision
  `{kind:'accept', content}` replaces the materialized result; block flips
  `isError` to true with feedback content).

## Replay Event Path

Construction site: `agent/session-start` listener, gated to
`source === 'resume' || 'compact'` (src/index.ts:394–407).

1. `sessionReplayEvents(agent.session.events)` keeps only `tool/call` and
   `tool/result`, in log order (src/index.ts:258–268).
2. `translateSessionEvents` pairs results to calls via
   `callId = message.source.callId ?? block.callId ?? block.toolCallId`;
   orphan results are skipped (`continue`) (src/index.ts:274–305). The pending
   Map is NEVER deleted from: a duplicate result record would pair twice.
3. A dangling `tool/call` (crash before its result was logged) produces NO
   EngineEvent at all — nothing is emitted for it, ever.
4. Paired events go through THE SAME `toEngineEvent`, then
   `ProgressFactEngine.rebuild(events)` = fresh engine + N × `applyEvent`,
   then `engines.set(agent, rebuilt); forced.delete(agent)`.

Lifecycle publication order, verified in LOCKED rc.6 sources:

- `AgentRegistry.announce(agent)` emits `agent/created` (agent src/index.ts,
  rc.6 commit: announce body dispatches `['agent/created', {agent}]`).
- Resume flow: `AgentLoop.resumeWith` → `setupAndPublish(..., 'resume')` →
  `publish('resume')` performs `agents.enter` → `sessions.announce` →
  `agents.announce` (= `agent/created`) → THEN
  `emitAgentEvent(..., 'agent/session-start', {source})`
  (agent-loop src/index.ts @15148dbd9a lines ~556–568, 699–703; README states
  the same order: "announce session/created then agent/created; emit
  agent/session-start; and only then start the driver").
- Therefore on rc.6 resume, `agent/created` fires synchronously BEFORE
  `agent/session-start(resume)` → the router's restriction is re-applied on
  every resumed agent. (Deployment caveat applies only if a deployment ran a
  DSH version other than the lockfile pin.)
- rc.6 reserves `'clear'` and `'compact'` in `SessionStartSource` with NO
  emitter ("reserves 'clear'/'compact' with no emitter yet", agent README
  @15148dbd9a:121). Consequences measured on the governor:
  - the `'compact'` rebuild branch is DEAD CODE under lockfile semantics
    (compaction cannot trigger a rebuild through this event in rc.6);
  - ignoring `'clear'` is currently unobservable (nothing emits it), though
    the code path would keep any existing cached engine if a future emitter
    reused the same Agent object.

The pairing shape itself matches real logs: `tool/result.data.message.source =
{kind:'tool', callId}`, single-block tuple content, `isError` boolean present
in inspected samples (executor-observed, see Evidence Index).

## Live vs Replay Proven Equivalence

Three distinct levels must not be conflated:

A. Shared transition function — YES, proven: both paths call the same
   `toEngineEvent` (src/index.ts:206; live caller :462; replay caller :296)
   and feed the same `ProgressFactEngine.applyEvent` (core src:267; replay
   loop inside `static rebuild`, core src:439–442).

B. Event domain equivalence — NO. The event SETS differ (next section).

C. Full runtime semantic equivalence — NOT PROVEN, and contradicted by the
   divergences below plus adapter-local state handling (forced budget reset;
   TurnState pollution). The source comment "so resumed state cannot drift by
   construction" is therefore NOT inherited by this inventory: shared function
   ≠ shared event domain ≠ full runtime equivalence.

What CAN be said precisely: for a root-call-only session whose log content
was never rewritten, whose results carried explicit isError values, and
ignoring round boundaries, replay reproduces generation/ring/receipts
identically (this is exactly what the synthetic fixture tests pin:
adapter.spec.ts:105–143, 168–176; core.spec.ts:232–246). Those tests compare
`snapshot()` outputs only — i.e., they prove SNAPSHOT-VISIBLE PROJECTION
EQUALITY, not full runtime semantic equivalence (chain, turn, forced, and
lifecycle state are outside the projection).

## Known Live vs Replay Divergences

Each item is a current-behavior fact, not a defect ruling:

D1. Code-mode sub-dispatch effects (structural):
    live sees nested `write`/`edit`/`str_replace_editor`/bash executions as
    individual post-execute events (mutation/verification included); replay
    consumes only root `tool/call|tool/result` records — sub-dispatch outcomes
    are logged as `tool/code-dispatch-start|tool/code-dispatch`, which
    `sessionReplayEvents` filters out (types/index.d.ts:62–75 names the
    durable record type; executor-observed real-log counts: 48 code-dispatch
    vs 32 tool/call in one run_code-heavy session).

D2. Minimal semantic counterexample (recorded as current divergence; runtime
    half proven in /tmp experiments):

    ```
    1. bash `npm test` PASS           → receipt pass @generation 0
    2. run_code └ nested write(...)   → LIVE: post-execute sees mutation
                                        generation → 1, old PASS now stale
    3. crash / resume
    4. replay ignores code-dispatch   → rebuilt events: [bash pass, run_code(non-mutation)]
    5. rebuilt generation stays 0     → RUNTIME-VERIFIED (experiment A)
    6. historical pass@0 == current gen 0 → stale PASS presents as CURRENT
       (isStale === false; STALE flag absent from evidence rendering;
        completion-guard rule 1 satisfied incorrectly)
    ```

D3. Post-execute replacement/block: governor hashes PRE-decision content;
    the durable log stores POST-decision content (accept-content replacement
    or block feedback). Any downstream listener doing so changes replay hashes
    vs live hashes. Mechanism proven in rc.6 dsh-tools; occurrence frequency
    in deployed stacks unknown.

D4. Replay-only events: scheduler `final-result` failures bypass post-execute
    live but still materialize into logged `tool/result` records → rebuild
    processes observations live never saw.

D5. Compaction rewriting `tool/result` content: declared authoritative-current
    in code comments and PLAN; hash drift vs live-era observations accepted.
    Note additionally that under rc.6 lockfile semantics compaction does not
    emit `session-start('compact')` at all (no emitter yet), so a mid-session
    compaction leaves the live engine untouched while the log is rewritten;
    drift surfaces only at the next actual resume.

D6. Duplicate `tool/result` records: pairing never removes the pending entry
    (no `pending.delete(callId)`), so duplicates replay as DUPLICATE
    EngineEvents. Runtime-proven effect: one duplicated successful mutation
    advances generation TWICE (experiment D: gen=2 after one write applied
    twice). Also double-counts ring entries and TurnState observations, and
    overwrites receipts. Live cannot produce this shape; frequency in real
    logs unknown (none found in inspected samples).

D7. Round-boundary asymmetry: live rounds are delimited by adapter
    `endTurn()` at `turn-stopping`; `rebuild()` replays ALL history with no
    boundary — everything folds into ONE TurnState (see Turn / Round State
    Reality).

## State Inventory

governor-core per-engine private fields (class `ProgressFactEngine`,
src/index.ts:223–232):

| State | Defined / written | Read | Lifetime | Classification (observed) |
| --- | --- | --- | --- | --- |
| `generation` (:228) | `onMutation()`; `applyEvent` on mutation | `currentGeneration` → evidence render, guard, classify, isStale | per engine instance | DERIVED_STATE (from replay-visible root mutation tools only) |
| ring `RingEntry[]` window 8 (:229) | push/shift in `applyEvent`; prune on mutation (:281–285) | `classifyObservation`, `snapshot()` | sliding window | DERIVED_STATE |
| receipts `Map<command,Receipt>` latest-wins (:230) | `recordReceipt` via verification branch (:290–303); public setter (:406) | `receiptFor/isStale/snapshot().receipts` → systemPrompt render, guard | per engine | DERIVED_STATE |
| zero-progress chain (`chain` :231) | `endTurn` (+1/→0), `resetChains`(=0) | verdicts, ladder policy | process | EPHEMERAL_STATE (never snapshotted; rebuild leaves 0; whether preservation matters is unresolved) |
| turn `TurnState` (:232, interface :545) | lazily `??= newTurnState()` in `observeTurn` (:319); cleared by beginTurn/endTurn/resetChains | inline reminder, settle verdicts | one ROUND when driven by boundaries; UNBOUNDED across rebuild | EPHEMERAL_STATE (but see Turn Reality: rebuild populates it) |

TurnState fields (all within the above container): observations, mutation,
significant, verifyNew, verifyPass, inlineStreak, inlineFingerprint,
inlineReminder, inlineReminderFired, repeatedPattern.

## Adapter-Local State

dsh-governor `apply()` closure state (src/index.ts:370–372):

| State | Written | Read | Cleared | Lifetime |
| --- | --- | --- | --- | --- |
| `engines: WeakMap<Agent,ProgressFactEngine>` | lazy create (:381–385); rebuild swap (:402) | all listeners + inject (:420–430) | GC with Agent object | process |
| `forced: WeakMap<Agent,number>` | +1 on ladder steer and guard steer (:506, :532) | budget checks (:503, :518) | user pre-step (:489); resume (:403) | process |

Router restriction: installed once per agent at `agent/created`
(:441–455) into DSH's tools service; disposer owned by agent scope lifecycle.
Config-driven; no governor-side persistent memory; VERIFIED to re-fire before
session-start(resume) on rc.6 (publication order above). Plugin listener
registrations and disposal are Cordis-owned (:333, :534–536). Config knobs
(schema :96–152; bundle row `cordis.patch.yml`) are mount-time CONFIGURATION.

## DSH-Native Durable Facts

Verified against rc.6 type definitions and (where noted) real logs:

- `tool/call {turn, step, callId, name, arguments(raw JSON string)}`
  (dsh-session types.d.ts:283–290) — replay identity + argument source.
- `tool/result {message{source{kind:'tool',callId}, content:[ToolResultBlock]},
  error?, meta?}` (types.d.ts:299–310; dsh-llm message.d.ts:140–144,
  types.d.ts:69–74) — replay hashing/isError; `source.callId` required,
  block `isError` optional.
- Exit-status markers `[exit code: N]` / `[killed by signal: X]` /
  `[timed out after …]` — owned by dsh-shell renderers (dsh-shell
  lib/index.js:13–14, 32–37); the governor mirrors them read-only.
- `assistant/message` texts — rule-3 claim input (`lastAssistantText`
  backward scan, dsh-governor src:303–330).
- `user/message` source kinds — interjection-reset predicate (:486–493).
- `turn/end` reason incl. crash-tolerant `'interrupted'` ("events recorded
  before the crash remain intact", dsh-session types.d.ts:162–166) — present
  but unconsumed by Orcana.
- `tool/code-dispatch-start|tool/code-dispatch` — the durable record type for
  sub-dispatch outcomes (dsh-tools types/index.d.ts:62–75); unconsumed by
  Orcana replay (divergence D1).
- `session/end-seed`, request headers, compaction brackets — unconsumed.
- Checkpoint/durability ownership: `dsh-session-checkpoint-policy` (per
  SessionEventMap docs); Orcana neither forces nor observes checkpoints.

Real-log evidence discipline: the pcba session sample (identity, command,
counts, shapes listed in Evidence Index) is EXECUTOR-OBSERVED on this machine
— not independently reproducible from the repository alone. Repository-only
proof covers shapes/types via pinned dependencies; the concrete counts are
local observations.

## EngineSnapshot Reality

`EngineSnapshot = {generation, ring, receipts}` (core src:82–87).

Correct conclusions retained from Rev.1:

- NOT durable storage: no fs/db/session writer exists anywhere; created only
  as a READ MODEL (`snapshot().receipts` at dsh-governor :426 inject and
  :529 guard input) and in tests; `restore()` has zero production callers
  (tests only, core.spec.ts:227–228). Exactly one durable truth (the log) and
  one reconstruction path (rebuild) exist.

Proof boundary corrected in Rev.2:

- The snapshot PROJECTION omits: chain, TurnState, forced budget, router/
  plugin lifecycle state, world state, and outstanding ambiguous (dangling)
  calls. Therefore `expect(replayed.snapshot()).toEqual(live.snapshot())`
  (adapter.spec.ts:120,176; core.spec.ts:245) proves snapshot-visible
  projection equality ONLY. It cannot establish full live/replay runtime
  semantic equivalence — and indeed the projection can match while turn state
  differs (projection excludes turn entirely).

## Existing Recovery Capability

Fine-grained matrix. Verdicts reflect CURRENT behavior under rc.6 lockfile
semantics, including the divergences above — not idealized root-only sessions.

| Capability | Verdict |
| --- | --- |
| DSH session durable history exists and is append-only/crash-tolerant-prefix | SUPPORTED (rc.6 types + real logs) |
| Root tool call/result reconstruction from log | PARTIAL (shape verified; isError optional with silent false-default; content may have been rewritten by compaction or post-execute decisions) |
| Generation rebuild from replay-visible ROOT mutation-tool successes | SUPPORTED (write/edit/str_replace_editor successes replay deterministically; experiment: gen=1 after rebuild) |
| Complete workspace-mutation reconstruction | NOT_SUPPORTED (code-mode nested mutations invisible to replay — D1/D2; bash-side mutations never counted at all — see World Boundaries) |
| Verification receipts from replay-visible ROOT bash results | SUPPORTED (statuses/generations recomputed identically; experiment) |
| Complete live verification-state reconstruction | PARTIAL (root-bash receipts recover; nested-in-run_code verifications and post-execute-replaced results do not) |
| Freshness relative to INTERNAL generation | SUPPORTED (isStale comparison deterministic; STALE rendering off rebuilt state) |
| Freshness relative to ACTUAL workspace/world | PARTIAL (internal freshness is only as good as generation; both bash mutations and code-mode mutations break the link — experiments A/E) |
| Ring reconstruction | PARTIAL (structure/window semantics rebuild; hashes drift when content rewritten — D3/D5) |
| Zero-progress chain recovery | NOT_SUPPORTED (not in snapshot; rebuild starts at 0; current behavior resets it — whether preservation matters is unresolved) |
| Clean turn-local reset at resume | NOT_SUPPORTED — CONTRADICTED BY CURRENT REBUILD (rebuild populates TurnState; see next section) |
| Forced-continuation budget recovery | NOT_SUPPORTED (deleted at resume; raw material EXISTS in logged plugin steers but nothing counts it back) |
| Completion DECISION recomputation after resume | SUPPORTED (guard is stateless per stop: generation+receipts rebuilt, lastAssistantText read from durable log) |
| Completion CORRECTNESS after resume | PARTIAL (inputs can be wrongly rebuilt: missed nested mutations make rule 1 pass when it should fire — counterexample A; unknown-outcome omissions reduce rule coverage) |
| Recorded timeout/signal outcomes → unknown receipts | SUPPORTED (markers persist in rendered text; receiptStatus maps interrupted → 'unknown') |
| Dangling dispatched-execution ambiguity preserved | NOT_SUPPORTED (call-without-result is silently omitted — see Unknown/Ambiguous Execution) |
| Code-mode nested effects reconstruction | NOT_SUPPORTED (D1/D2) |
| Router reapplication on rc.6 resume | SUPPORTED (VERIFIED publication order: agent/created precedes agent/session-start(resume); lockfile-pinned version) |
| Real crash/resume correctness (end-to-end, production conditions) | NOT_SUPPORTED as a proven property (no test drives apply()+session-start; multiple divergences above are unmeasured in the wild) |

## Turn / Round State Reality

This section replaces Rev.1's wrong claim ("first post-resume round starts
empty"). Runtime-verified mechanics:

- `static rebuild(events)` = fresh engine + `for (event of events)
  applyEvent(event)` with NO beginTurn/endTurn (core src:439–442).
- `applyEvent` ALWAYS ends in `observeTurn`, which lazily creates the round
  aggregate: `const turn = this.turn ??= newTurnState()` (core src:319).
- Therefore after replaying N≥1 historical events, `this.turn` is a SINGLE
  accumulated TurnState spanning the entire history, with sticky fields:
  - `mutation=true` iff ANY historical event was a mutation (sticky forever
    until a settle);
  - `significant=true` iff ANY non-verification observation classified
    progress/new-evidence/first-observation — which includes the FIRST
    historical observation of any non-verification tool;
  - `verifyNew/verifyPass` set by first-ever verification / any pass receipt;
  - `inlineStreak/inlineFingerprint` = trailing same-fingerprint run;
    `inlineReminder` ARMED (and `inlineReminderFired=true`) if the history
    ENDED with ≥ threshold consecutive identical inline-tool observations;
  - `repeatedPattern` = last repeated observation of history.
- Runtime proof (experiments B/B2, /tmp/r0a-experiment.mts):
  - After rebuilding a history containing [reads, write-mutation, npm-test
    pass], the FIRST post-resume live round consisting purely of two repeats
    of an already-known read settles as `zeroProgress:false, chainLength:0`
    — the genuinely zero-progress round is INVISIBLE because the aggregate
    carries historical mutation/significance.
  - With a history ending in two identical reads, `consumeInlineReminder()`
    returns the reminder text ON THE FIRST post-resume live observation:
    the model receives "You are repeating the exact same call…" about
    PRE-CRASH calls.
- Consequently the first post-resume `turn-stopping` settles a MIXED
  TurnState (history + new round): the chain restarts from 0 based on
  polluted inputs, and `verdict.repeatedPattern` may name a historical
  pattern. The pollution persists until the first settle (endTurn clears) or
  a user-interjection `resetChains`.
- Field-state table after rebuild of non-empty history: observations=N;
  mutation/significant/verifyNew/verifyPass as sticky rules above;
  inlineStreak/inlineFingerprint=trailing run; inlineReminder=armed iff
  trailing run crossed threshold; inlineReminderFired=sticky true once armed;
  repeatedPattern=last historical repeat. Q&A: (1) `this.turn` is NOT empty;
  (2) yes — without boundaries all history folds into one TurnState; (3–11)
  as listed; (12) YES — a history-armed reminder is consumed by the first
  live execution; (13) YES — the first settle judges a mixed aggregate.

These are recorded runtime facts. Whether the mixed-aggregate settle or the
history-armed reminder matters for governance quality is unresolved here.

## Completion-State Reality

- Mechanism: completion eligibility is NOT a durable boolean. At every
  `turn-stopping`, violations are RECOMPUTED from
  `{generation, receipts} ∪ lastAssistantText(session)` (dsh-governor
  :499–534; core `completionViolations` :697+). Recomputation itself is
  deterministic and survives resume structurally.
- Correctness boundary: each input inherits the divergences above —
  generation misses code-mode/bash mutations (A/E), receipts inherit hash/
  inclusion gaps (D1/D3/D4/D6), unknown-outcome omission shrinks evidence
  (below). Hence: mechanism recomputation SUPPORTED; correctness after
  resume PARTIAL.
- Rule-3 text input is read from the durable log backward scan — resume-safe
  as a mechanism.

## World State Boundaries

- Actual filesystem/git/process/external-service state is WORLD state; Orcana
  holds no model of it beyond `generation`.
- `generation` is a COARSE RUNTIME FACT derived solely from recognized
  mutation-TOOL successes ({write, edit, str_replace_editor}, non-error). It
  is not an authoritative workspace version: runtime-proven examples where
  the workspace changes while generation does not: `bash "sed -i …"`,
  `bash rm/git-checkout/script` (experiment E: sed -i left generation at 0
  while a prior npm-test receipt remained "fresh"), and nested code-mode
  writes (visible live, lost on replay — A).
- Conversely a recognized mutation success says nothing about what the write
  DID to the world. Internal-vs-world freshness is therefore split explicitly
  in the capability matrix.
- Background shells alive at crash time, external side effects without a
  logged result, and clock/env/provider state are outside any reconstruction
  path in this repository.

## Unknown / Ambiguous Execution

Two distinct ambiguity classes behave differently today:

- Case A — outcome recorded as ambiguous: a durable `tool/result` carrying
  `[timed out after …]` or `[killed by signal: X]` reconstructs to
  `status:'unknown'` (interrupted dominates exit markers; core
  `receiptStatus`). Ambiguity remains ambiguity. SUPPORTED.
- Case B — existence recorded, outcome absent: a durable `tool/call` whose
  result never landed (crash mid-execution) yields NO EngineEvent —
  `translateSessionEvents` only emits on results, so the ATTEMPT is silently
  omitted from reconstruction (runtime-checked: 0 events produced). "Unknown
  execution fact" is NOT recovered as unknown; it disappears. These are not
  the same property, and the difference is recorded here as fact.

## Unknowns

1. Whether the DEPLOYED harness runtime matches the lockfile-pinned rc.6 for
   lifecycle publication order and code-dispatch logging (verification here
   is against rc.6 sources/artifacts; deployments running other versions
   inherit their own semantics).
2. Checkpoint-policy flush timing relative to post-execute (how much tail a
   crash can lose between live observation and durable record) — owner
   package (`dsh-session-checkpoint-policy`) not audited in this pass.
3. Frequency of post-execute content replacement/blocking by downstream
   listeners in deployed stacks (mechanism certain, occurrence unmeasured).
4. Frequency of duplicate `tool/result` records in real logs (none found in
   inspected samples; mechanism consequences runtime-proven).
5. Whether background completions produce later observable result events
   (background acks are excluded from verification identity by design; their
   eventual status is invisible to the engine).
6. Master Plan document unavailable on this machine (path in Baseline);
   taxonomy/decision-rule cross-references could not be re-verified against
   it this pass.

## Candidate Gaps

Factual gaps only — no fix design:

1. Rebuild populates a never-settled TurnState; first post-resume round is
   judged as a mixed aggregate, and a history-armed inline reminder fires on
   the first resumed observation (runtime-proven).
2. Code-mode nested mutations/verifications are live-observed but
   replay-filtered; conversely final-result pipeline failures are
   replay-visible but never live-observed (two structural domain
   asymmetries around the shared-transition claim).
3. `translateSessionEvents` neither deduplicates repeated results nor
   consumes pending entries (duplicate replay double-counts; runtime-proven
   generation inflation).
4. Dangling `tool/call`s are silently dropped rather than represented as
   unknown-outcome facts.
5. `docs/architecture.md` still describes resume wiring as "pending (H1)"
   although the listener shipped; it also predates these divergence facts.
6. `benchmark/runner/analyze.mjs` keeps a second translation copy: own
   pairing (also without pending-delete), extra `step/end` round boundary,
   raw `block.isError` without false-default, no code-dispatch consumption —
   benchmark replay metrics are NOT equivalent to production resume
   semantics and should not be treated as a recovery authority.
7. `EngineSnapshot.restore()` and `beginTurn()` are exported surface with
   zero production callers.
8. Snapshot-equality tests bound the proven property to projection equality;
   chain/turn/forced/lifecycle are outside every consistency test.
9. Forced-continuation history exists in the log (plugin-source steers) but
   is discarded at resume.
10. rc.6 `'compact'`/`'clear'` emitters do not exist; the governor's compact
    rebuild branch is dead code under lockfile semantics (relevant the day
    those subsystems land).

## Evidence Index

Repository (branch `research/durable-recovery-r0-a`):

| Conclusion | path | symbol / lines |
| --- | --- | --- |
| Engine fields incl. chain/turn | packages/governor-core/src/index.ts | 223–232; TurnState 545+ |
| Lazy TurnState creation | packages/governor-core/src/index.ts | `observeTurn` 312–319 (`this.turn ??=`) |
| rebuild has no boundaries | packages/governor-core/src/index.ts | `static rebuild` 439–442 |
| endTurn settle semantics | packages/governor-core/src/index.ts | 367–382 |
| beginTurn/consumeInlineReminder | packages/governor-core/src/index.ts | 356–359, 397–403 |
| snapshot contents & restore | packages/governor-core/src/index.ts | 82–87, 421–437 |
| MUTATION_TOOLS/SHELL_TOOLS | packages/dsh-governor/src/index.ts | 155–163 |
| toEngineEvent | packages/dsh-governor/src/index.ts | 206–236 |
| sessionReplayEvents filter | packages/dsh-governor/src/index.ts | 258–268 |
| translateSessionEvents (pairing, orphan skip, NO pending.delete) | packages/dsh-governor/src/index.ts | 274–305 (esp. 279, 285) |
| engines/forced WeakMaps | packages/dsh-governor/src/index.ts | 370–372 |
| session-start gate resume/compact + forced.delete | packages/dsh-governor/src/index.ts | 394–407 |
| router at agent/created | packages/dsh-governor/src/index.ts | 441–455 |
| post-execute handler (fold before next; reminder ride-along) | packages/dsh-governor/src/index.ts | 460–484 |
| pre-step user reset | packages/dsh-governor/src/index.ts | 486–493 |
| turn-stopping ladder + guard | packages/dsh-governor/src/index.ts | 499–534 |
| Projection-equality tests only | packages/dsh-governor/tests/adapter.spec.ts; governor-core/tests/core.spec.ts | 120, 176; 245 (and 227–228 restore-in-tests) |
| No session-start behavior test | packages/dsh-governor/tests/apply.spec.ts | covers post-execute/pre-step/turn-stopping/created only |
| Second translation in benchmark | benchmark/runner/analyze.mjs | filter 186; pairing 199–204; raw isError 208; step/end boundary 223–227 |
| Stale architecture doc | docs/architecture.md | Durability/replay rows ("pending — H1") |
| Lockfile pins | pnpm-lock.yaml | dsh-* @ 0.1.0-rc.6 (lines 36–47, 130+) |

Locked rc.6 dependencies (installed artifacts under
packages/dsh-governor/node_modules/@deepseek-ai/, corroborated by harness
monorepo `git show 15148dbd9a:` where noted):

| Conclusion | artifact | location |
| --- | --- | --- |
| postExecute waterfall; accept-content/block replacement AFTER listeners | dsh-tools lib/index.js | 3359–3388 |
| finalize/bypass scheduling (final-result skips post-execute) | dsh-tools lib/index.js + types/index.d.ts | 2997–3004, 3223–3225; types 301–303, 121–124 |
| code-mode nested executions share the registry path; inner name preserved; parent token | dsh-tools lib/index.js | 884–891, 2880–2891, 3008–3029 |
| sub-dispatch durable record = tool/code-dispatch | dsh-tools lib/types/index.d.ts | 62–75 |
| SessionEventMap shapes; raw arguments string; interrupted turn-end | dsh-session lib/types/types.d.ts | 223–354 (283–290, 162–166) |
| ToolResultMessage/source/isError optionality | dsh-llm lib/types/{message,types}.d.ts | message 22–25, 140–144, 185–189; types 69–74 |
| SessionStartSource incl. reserved clear/compact | dsh-agent lib/types/runtime-types.d.ts (installed); agent README @15148dbd9a:121 (no emitter yet) | 57–61 |
| announce emits agent/created; resume publish order created → session-start(resume) | harness monorepo @15148dbd9a | agent/src/index.ts announce body; agent-loop/src/index.ts 556–568, 699–703 |
| exit-marker owner | dsh-shell lib/index.js | 13–14, 32–37 |

Runtime experiments (executor-run on this machine; reproducible against the
repo with node ≥22.6):

| Experiment | Command | Result |
| --- | --- | --- |
| B/B2: polluted first-round settle; armed reminder crosses resume | `node --experimental-strip-types /tmp/r0a-experiment.mts` (imports governor-core src directly) | first pure-repeat round → `{zeroProgress:false,chainLength:0}`; `consumeInlineReminder()` returns reminder text on first post-resume event |
| D: duplicated mutation doubles generation | same file | one write applied twice → generation 2 |
| A/E/C: stale-PASS resurrection; bash mutation invisible; dangling call silent | `node --experimental-strip-types /tmp/r0a-experiment2.mts` | rebuilt gen 0 with `isStale(pass@0)===false`; sed -i leaves gen 0; dangling call → 0 events |

Executor-observed local data (NOT reproducible from the repository alone):
real session log `~/.dsh/sessions/--home-fuqiang-projects-pcba--/3f326596-f2e7-4c7e-9701-48da608a908e/session.jsonl.zstd`,
read with `zstd -dc <file>` + python JSON line scan; event-type counts
included `tool/call:32, tool/result:32, tool/code-dispatch-start:48,
tool/code-dispatch:48, assistant/message:33`; sampled shapes matched the fixed
ReplayEvent model (`message.source={kind:'tool',callId}`,
block `{type:'tool-result',toolCallId,isError:true|false}`).

## R0-A Status

Revision complete: all audit findings addressed with fresh source reading and
runtime verification; report structure, capability granularity, and proof
boundaries corrected as specified. Remaining items are listed under Unknowns
(including the unavailable Master Plan document). Independent re-audit is
owed the final judgment; this revision claims readiness for it, nothing more.
