# R0-C — Crash Boundary & Ambiguity Analysis

Answers, for each semantically distinct lifecycle boundary: what is already
durable, what may be durable, what remains unknown, what can be reconstructed,
what requires world re-observation, and what recovery logic must never assume.

Docs-only failure-boundary analysis over current real sources. No recovery
implementation, no new durability machinery, no dedupe/replay/fix of any kind.
Defects found are documented, not repaired.

## Baseline & Version Assumption

- Branch `research/durable-recovery-r0-c` (from accepted R0-B tip);
  starting HEAD `708b38a82e310ee738544e761474ff3534e0c2ec` (= ACCEPT_R0_B
  candidate); worktree clean at start.
- Lockfile resolves `@deepseek-ai/dsh-*` **0.1.0-rc.6** — same semantics base
  as accepted R0-A/R0-B evidence. No VERSION_SKEW detected in-repository.
- **VERSION ASSUMPTION**: analysis describes the repository-resolved rc.6
  semantics; deployed-environment equivalence remains unverified.
- Source seams unchanged since the audited R0-A/R0-B reads (`git diff --stat
  215595e -- packages/ benchmark/` empty). DSH-side citations read from rc.6
  artifacts / harness monorepo `@15148dbd9a`.
- Behavioral-test basis (cited per boundary): Orcana repo suites (governor-core,
  dsh-governor) plus DSH-side specs located in the harness monorepo:
  `session/tests/repair.spec.ts` (direct TOOL_NOT_STARTED /
  TOOL_OUTCOME_UNKNOWN behavioral coverage), `session-checkpoint-policy/
  tests/session-checkpoint-policy.spec.ts`, `session-persistence/tests/
  persistence.spec.ts`, `session-persistence-jsonl/tests/jsonl.spec.ts`,
  `agent-loop/tests/{resume,request-reconstruction,scope-lifecycle}.spec.ts`.

## Method

Boundaries below are SEMANTIC states — crash points that change what recovery
can truthfully say — not instruction-level positions. Where two crash moments
produce no observable recovery difference they are merged; where the
write-behind race changes a repair code (`TOOL_NOT_STARTED` ↔
`TOOL_OUTCOME_UNKNOWN`) they are separated.

Classification vocabulary used in every row:

- **KNOWN** — proven by source/persistence contract.
- **CONDITIONALLY KNOWN** — true iff a runtime condition held that history
  cannot always confirm after the fact (e.g., write-behind drained before
  crash).
- **UNKNOWN** — external/world outcome; cannot be derived from history.
- **RECONSTRUCTABLE** — crash-surviving history + fixed current inputs
  determine it.
- **REQUIRES WORLD OBSERVATION** — Session history is not authority for this;
  fresh observation is the only resolver.
- **UNSAFE TO ASSUME** — assuming it manufactures false facts/confidence.
- `SOURCE DOES NOT PROVE` — the audited sources do not settle the question.

## Durability Model (recap, governing every row)

```
session.append → event ADMITTED to persistence controller
  ├─ write-behind batching MAY drain/persist it EARLIER
  │    (SessionWriteBehind, default max intentional delay 200ms)
  └─ explicit session.flush() GUARANTEES all previously admitted
       events are drained/persisted (quiescence barrier)
semantic checkpoints = explicit barriers layered on top:
  LLM request: flush complete request prefix BEFORE adapter dispatch
  top-level tool: flush recorded call BEFORE tool body
  agent/pre-step: flush preceding committed batch BEFORE next step
  nested execution: NO independent checkpoint (reuses outer call's durability)
```

Neither "append ⇒ durable" nor "durable only at next checkpoint" is correct.

## Master Crash Boundary Table (summary)

| ID | Boundary | Guaranteed-durable once past | Conditionally durable | Non-durable/process-local | Repair interpretation | World ambiguity |
| --- | --- | --- | --- | --- | --- | --- |
| A | LLM request prefix vs dispatch | after flush: full logged request prefix | header/request records between append and flush | in-flight stream chunks beyond committed log | n/a (no tail synthesis for headers) | none directly |
| B | top-level call record vs body start | after flush: the `tool/call` | the call between append and flush (write-behind race) | scheduler-preparation state | write-behind race selects TOOL_NOT_STARTED vs TOOL_OUTCOME_UNKNOWN | side effects impossible yet (body not started) |
| C | body began → no durable result | the `tool/call` (crossed barrier) | partial output text (process-local) | everything execution-local | TOOL_OUTCOME_UNKNOWN synthetic result | YES — side effects MAY have occurred |
| D | result appended → durability timing | depends on sub-state (D1/D2/D3) | THE RESULT ITSELF | post-execute derived governor state | absent result ⇒ OUTCOME_UNKNOWN even if body completed | possible completed-but-unrecorded |
| E | result durable, Orcana state stale | result | none extra | ALL Orcana engine/adapter state | n/a (result already in history) | inherited from result's own ambiguity status |
| F | code-mode nested lifecycle | outer run_code `tool/call` (post-barrier) | `-start`/`-dispatch` pairs individually | worker memory / intermediate values | NO synthetic closers for nested records (repair scans tool/call only) | YES per unresolved sub-dispatch |
| G | mutation result observed | the mutation result (once durable) | pre-barrier window | live generation increment | rebuilt gen tracks only SURVIVING visible mutations | workspace truth ≠ generation |
| H | verification result observed | the verification result (once durable) | pre-barrier window | receipt in engine map | unknown-outcome verifications project FAIL | present validity needs world |
| I | PASS → later mutation → crash | whichever records crossed barriers | the later records | derived staleness view | repair may freeze generation ⇒ stale-PASS resurrection | HIGH — freshness unknowable without observation |
| J | mid-turn heuristic settlement | steer messages ONLY once claimed into a step | nothing else heuristic | TurnState/ring/chain/budget/inbox entries | settlements themselves leave NO durable trace | none directly |
| K | before completion decision | prior durable facts only | none | violation set, guard decision | recomputed next stop | as per underlying evidence |
| L | completion facts produced → dies pre-exit | the verification/fact records | any unbarriered appends | the "allowed" decision (never durable) | recomputed | per underlying facts |
| M | background/interruptible op | dispatch ack (ordinary result) | eventual outcome UNLESS job-tool queried later | ctx.jobs registry | no dedicated repair | outcome unknown w/o query/world |

## Boundary A — Before LLM Dispatch

Lifecycle chain (source): step begins → request facts appended
(`request/header` on first/resume/change — agent.ts:459–467) → … →
`llm/stream` wrapper flushes session BEFORE adapter first chunk (checkpoint-
policy :30–40).

Sub-states:

- **A1 — request/header appended, flush not yet completed**: header is
  CONDITIONALLY KNOWN durable (write-behind may have drained; otherwise lost
  on crash). Post-crash: if lost, resumed loop rebuilds route from options and
  re-appends `{reason:'resume'}` or `'initial'`; an explicit reasoningEffort
  continuation owned by that route would be LOST with it (agent.ts:419–431).
  KNOWN: loss changes continued-request configuration semantics; it does not
  corrupt interaction truth (no half-state).
- **A2 — flush completed**: entire logged request prefix is GUARANTEED durable
  (KNOWN). Crash here loses only uncommitted stream output.
- **A3 — adapter dispatch begun**: identical durability position to A2 for
  logged facts; additionally the model call itself is in flight — its
  assistant output is UNKNOWN until streamed/appended (no partial assistant
  record exists; `assistant/chunk` telemetry may persist via write-behind but
  carries no reconstruction role).

Unsafe assumption: treating an in-memory `requestHeader()` fold as durable.
Orcana impact: none directly (no consumer); DSH resume configuration semantics
affected only at A1.

## Boundary B — Before Top-Level Tool Execution

Chain (source): assistant/message appended (with tool-call blocks) → loop calls
`appendToolCall` (:262–265) → scheduler prepare/dispatch → `tools/execute`
waterfall: checkpoint-policy flushes (:70–76) → body runs.

Sub-states and repair mapping (repair = `interruptedTurnClosers`, which marks
pendingCalls from assistant blocks and upgrades them when a `tool/call` seq is
present):

- **B1 — assistant block durable, `tool/call` NOT appended** (crash between
  message append and call append): repair emits synthetic result with
  `TOOL_NOT_STARTED` (KNOWN — repair.spec.ts:50–81). No execution began ⇒ no
  world side effect from THIS call. Retry guidance differs by design.
- **B2 — `tool/call` appended, pre-body flush NOT completed**: the call is
  CONDITIONALLY durable — the write-behind race decides. If it survived ⇒
  repair sees `callSeq` ⇒ `TOOL_OUTCOME_UNKNOWN`; if not ⇒ `TOOL_NOT_STARTED`.
  **This is a semantically distinct boundary pair precisely because the repair
  code differs.** The choice is NOT knowable from wall-clock order alone
  post-crash — only from surviving bytes.
- **B3 — flush completed, body not started / aborting**: call guaranteed
  durable; abort path materializes aborted-before-dispatch error result
  (policy :43–49) — ordinary result semantics apply.
- **B4 — body begins**: call is behind the explicit barrier (KNOWN). World
  effects become possible → Boundary C applies.

Repair-code premise note: `TOOL_NOT_STARTED`'s precondition is "assistant
request survived, call did not"; `TOOL_OUTCOME_UNKNOWN`'s is "call survived".
Both premises are about SURVIVING BYTES, not about when the crash happened.

## Boundary C — Body Began, No Durable Result (core ambiguity)

Facts: `tool/call` behind barrier (KNOWN durable). Execution ran for an
arbitrary duration. Result never entered crash-surviving history.

- DSH CAN prove: the call was recorded and started; no completed outcome was
  durably recorded.
- DSH CANNOT prove: whether the operation mutated anything; how far it got.
- Repair emits: synthetic `tool/result`, isError=true, error identity
  `ToolOutcomeUnknownError/TOOL_OUTCOME_UNKNOWN`, model-facing text instructing
  verify-then-retry (repair.ts:100–121; behavioral lock repair.spec.ts:229–261).
- World: side effects **MAY have occurred** (UNKNOWN). Absence of durable
  success ≠ proof of failure; the synthetic isError=true is a RECOVERY
  CONVENTION, not an observed outcome.
- Orcana projection today: pairs the synthetic result; `mutation=false`
  (isError suppresses); shell verification ⇒ receipt FAIL (UNKNOWN→FAIL
  downgrade, experiment G); generation frozen across the possible mutation (H).
- MUST remain UNKNOWN: actual effect; anything downstream claiming either way
  from Session history alone is UNSAFE TO ASSUME. Resolution =
  REQUIRES WORLD OBSERVATION.

## Boundary D — Result Appended, Crash Timing Ambiguous

Three sub-states that may be INDISTINGUISHABLE post-crash:

- **D1 — result in live memory only** (appended, write-behind had not drained,
  no barrier yet): crash loses it. Post-resume repair converts the dangling
  call into TOOL_OUTCOME_UNKNOWN — **even though the body may have COMPLETED**
  and produced a real outcome that was merely unrecorded.
- **D2 — write-behind persisted it**: survives as an ordinary result.
- **D3 — covered by a later explicit barrier** (pre-step / next top-level
  call / next request flush): survives identically.

Recovery ambiguity: after restart you observe result-present or result-absent;
in the ABSENT case you cannot distinguish "operation failed/was killed" from
"operation completed but its record lost". DSH's UNKNOWN classification is
therefore exactly right, and Orcana's FAIL projection is a semantic downgrade
of a genuine unknown (documented; not repaired here).

Also note ordering (E-relevant): the governor folds results at post-execute,
BEFORE the loop appends the result — so every result that reached durability
was necessarily already folded live; replay-vs-live result differences come
from projection/domain, not from missed live observations (except final-result
bypass cases, which reach the log WITHOUT ever being folded live).

## Boundary E — Durable Result, Orcana Process State Not Updated

Given a durable result: rebuild deterministically re-derives generation /
receipts / ring over the replay-visible stream (R0-B), TurnState comes back as
a polluted aggregate, chain resets to 0, budget resets. The crash-specific
consequence is limited to WHICH results survived (Boundaries C/D) — the
derivation itself adds no new ambiguity beyond the known projection gaps
(code-dispatch drop, replacement double-application, unknown→FAIL). No
taxonomy restated here per scope.

## Boundary F — Code-Mode Nested Execution

Vocabulary (producer-verified): outer `run_code` = ORDINARY root `tool/call`;
each launched nested operation appends `tool/code-dispatch-start`
{rootCallId,parentCallId,subCallId,name,arguments} at pipeline entry
(code-mode.ts:535–541) and settles with `tool/code-dispatch`
(+isError,content,:510–521). Queued-and-abandoned operations log NEITHER.

Sub-states:

| Sub-state | Raw history shows | DSH proves | Repair acts? | Orcana replay | World |
| --- | --- | --- | --- | --- | --- |
| F1 start not durable, no settle | outer call only | nothing about the nested op | NO synthetic closer (repair scans tool/call only) | nothing | side effect MAY have occurred — fully UNKNOWN |
| F2 start durable, settle absent | identity+args survive (name/args provable!) | sub-dispatch STARTED | none (not scanned) | dropped by filter | outcome UNKNOWN; effect may have occurred |
| F3 start+settle durable | full nested outcome | outcome (isError/content) | none needed | STILL dropped (gap stands) | resolved to the extent the content describes |
| F4 outer result absent | outer dangling → TOOL_OUTCOME_UNKNOWN closer | outer outcome unknown | yes (Boundary C rules) | inner records still filtered | compound ambiguity |

Nesting identity: survives IN RAW HISTORY (rootCallId/parentCallId/subCallId)
but has no representation in Orcana EngineEvent. Whether `-start`-without-
`-dispatch` could ever drive richer recovery is a later-phase question — no
mechanism proposed.

## Boundary G — Mutation Result Observed

Once a successful mutation result is durable: live generation already advanced
(fold precedes append); rebuild advances identically IF the record stays
replay-visible. Known divergences that break equality: nested code-mode
mutations (dropped — gen under-counts), surface replacement second application
(gen OVER-counts, experiment J), unknown-outcome mutations (never counted —
H). Generation remains a COARSE DERIVED RUNTIME FACT, never workspace
authority; durable-mutation ⇒ correct-generation is NOT a valid inference.

## Boundary H — Verification Result Observed

Verification result durable ⇒ receipt deterministically reconstructable given
verifyPatterns (config input). Receipt says "PASS at generation N historically"
— NEVER "workspace currently valid". If a crash separated the verification
from subsequent mutations, see Boundary I. Present validity always REQUIRES
WORLD OBSERVATION or a fresh re-run.

## Boundary I — Verification PASS → Later Mutation → Crash (high priority)

Sub-cases by survival:

1. Both records durable: rebuild yields advanced generation; old receipt
   correctly STALE. Correct behavior (fixture-pinned domain).
2. Verification durable; mutation RESULT lost (Boundary D1-style):
   repair synthesizes unknown-outcome (mutation=false) ⇒ rebuilt generation
   FROZEN at the verification's generation ⇒ old PASS presents CURRENT
   (experiments A/H). Completion-guard rule 1 then PASSES although the
   workspace may have changed — false-confidence risk. UNSAFE TO ASSUME
   freshness; REQUIRES WORLD OBSERVATION.
3. Mutation durable; later verification lost: spurious FAIL projection
   (unknown→FAIL) may fire guard rule 2 against a genuinely-unknown command.
4. Neither survives: both vanish; earliest earlier evidence governs —
   potentially stale by an entire unknown epoch.

Only case 1 is fully correct today; cases 2–4 are documented divergence
families, not defects repaired here.

## Boundary J — Mid-Turn Heuristic / Settlement State

Verified lifecycle: settlements occur ONLY inside `agent/turn-stopping`
dispatches (agent.ts:295–296); they emit NO durable record; a steer enqueues
to nextStep and becomes a durable `user/message` ONLY when the driver claims it
into a step (:281–284). One DSH turn can contain many settlements.

Crash points and consequences:

| Crash point | Durable | Lost/reset | Stop/continue consequence |
| --- | --- | --- | --- |
| before settlement N | prior round facts only | round observations (ring-rebuildable parts recover; verdict does not) | next resume starts chain=0; first settle polluted (proven) |
| after endTurn(), before decideSteer | nothing new | verdict + chain delta | resume recomputes from scratch — different ladder position possible |
| after decideSteer(steer) , before agent.steer | nothing | decision | resume never steers for that round |
| after agent.steer, before claim | NOTHING (inbox-only) | the steer message itself | stop that WOULD have been prevented now proceeds — control-flow difference vs no-crash |
| after claim (step started) | user/message (conditional on next barrier) | — | continuity restored modulo Barrier-D windows |

Preservation correctness value stays **AMBIGUOUS / UNRESOLVED** (unchanged;
no new direct evidence either way). No durability mechanism proposed.

## Boundary K — Before Completion Decision

Pure completion violation set = deterministic fn(generation, receipts,
lastAssistantText; claimCheck/claimPatterns/verifyPatterns) — recomputed at
every stop, never durable. Effective stop/continue = composite outcome also
gated by completion.mode and forcedCount<maxForcedContinuations (:517–518) and
realized through steer→nextStep (control flow). Crash anywhere before the
decision ⇒ decision simply never happened; next stop recomputes from rebuilt
inputs (with all documented input degradations). No durable "decision" exists
to restore — restoring one blindly would be UNSAFE (it is derived, config-
sensitive, and world-sensitive).

## Boundary L — Completion Facts Produced, Dies Before Exit

Scenario: fresh verification durable; obligations appear satisfied; turn
attempts to finish; process dies before normal termination.

- Authoritative survivors: whatever records crossed barriers (verification
  result, messages); plus repair closers if the tail was open.
- The prior "allowed"/"no-violation" outcome was NEVER durable — there is
  nothing to restore; eligibility is a DERIVED DECISION recomputed at the next
  stop from rebuilt inputs.
- Must never be blindly restored: eligibility, freshness judgments,
  generation-based claims (they inherit Boundaries C/I ambiguities).
- Completion impact: a task that WAS effectively complete may resume with
  degraded/incorrect derived inputs (see I) and re-steer or mis-assert —
  analysis only.

## Boundary M — Background / Interruptible Operation

Source-grounded shape: background bash returns an immediate ack result
(ordinary `tool/result`, job id text); settled outcomes land in a process-local
`ctx.jobs` registration mapped to completed/killed (+detail) —
tool-bash/background.ts:16–36; read back only via `job_output`/`job_kill`
tools, which produce their OWN ordinary call/result records when invoked.

Consequences:

- Session history proves: dispatch accepted (ack); any LATER job-tool queries.
- Eventual outcome is durable ONLY IF a job-tool interaction captured it;
  otherwise it dies with the process (registry is process-local).
- Historical absence of a job_output query does NOT prove failure, success, or
  completion — UNKNOWN; resolution = job-tool query (if runtime alive) or
  REQUIRES WORLD OBSERVATION.
- No exactly-once or at-least-once guarantee exists or is proposed. Parent
  death leaves the child per OS semantics — outside Session truth entirely.

## Compaction / Surface-Replacement Timing Family

Producer sequence (pruner src): prune pass iterates CURRENT-SURFACE results →
for each over-budget node APPENDS `compaction/prune` (shadow price) then
IMMEDIATELY-ADJACENT replacement `tool/result` (surfaceOp replace +
sourceEventSeqs). Crash points:

1. **Original durable, pruning not started**: raw=surface=original. Replay
   single-application. Unambiguous.
2. **Between the adjacent appends** (prune landed, replacement not):
   SOURCE DOES NOT PROVE the resulting state — `foldSurface` tolerance for an
   orphan shadow-price event was not audited. Flagged UNRESOLVED (narrow).
3. **Replacement appended, not yet durable**: crash loses ONLY the
   replacement; original remains authoritative-and-durable; post-restart
   surface derives the ORIGINAL again. Model-visible content reverts to full
   original — semantically safe (no truth manufactured), though token-bounded
   benefit lost.
4. **Replacement durable**: raw contains BOTH records; surface shadows
   original; current Orcana replay applies BOTH (generation doubling for
   mutation replacements — experiment J; receipt overwrite for verifications).

No dedupe fix designed (out of scope).

## `session/end-seed` Special Persistence Section

Producer (verified, session/src/index.ts:539–547): the SESSION CONSTRUCTOR —
when created WITH a seed and the seed does not already end with the marker —
appends `session/end-seed` BEFORE any backend attaches ("the marker is already
in `events` when a backend captures the creation seed: no load-time write";
re-opening an untouched session must not grow its log, so re-marking is
skipped when the last seed event is already the marker). It does NOT use the
ordinary runtime-append path and MUST NOT be modeled as
"admitted → write-behind → next checkpoint".

Persistence/materialization paths (verified):

1. **New seeded session** (coordinator :1283–1293): createCore registers LAZY
   intent (cursor 0, materialized:false — "No artifact until the first append",
   :645–658); then `if (seed.length > 0) await appendCore(id, seed)` persists
   the whole seed batch — INCLUDING the constructor-appended end-seed — via
   appendBatch/materialize. Crash before that appendCore completes ⇒ NO
   artifact ⇒ session invisible to `list()` and unrecoverable-by-id (header
   intent was memory-only). Single semantic boundary: pre-materialization vs
   materialized.
2. **Resume path** (prepareCore :892–931): stored balanced events seed the
   constructor; a fresh end-seed is appended ONLY IF the stored log does not
   already end with one. Its route to storage is the NORMAL controller drain
   (write-behind/barrier) with SUBSEQUENT appends — SOURCE DOES NOT PROVE an
   explicit flush of this marker during resume commit. Marked UNRESOLVED:
   whether a resume-with-no-further-writes leaves a live-only end-seed.
3. **Compaction consumption timing**: `inspectCompactionEntryState` reads
   end-seed from `session.events` (live view). After resume it therefore sees
   whatever the reloaded prefix contains; a live-only (undrained) marker would
   be visible in-process but absent from a SIMULTANEOUS cold reader — exact
   cross-reader semantics UNRESOLVED.

## `request/header` Boundary Precision (completing R0-B risk note)

Two distinct positions, never merge:

- **header appended, request flush not yet completed** — CONDITIONALLY
  durable (write-behind may have persisted it; crash may lose it). Loss
  consequence at resume: route re-derived from loop options; route-owned
  explicit reasoningEffort continuation lost (agent.ts:419–431); a fresh
  `{reason:'resume'|'initial'}` header is appended. Interaction truth intact;
  configuration CONTINUITY degraded.
- **flush completed / adapter dispatch begun** — the logged request prefix is
  BEHIND the guaranteed barrier (KNOWN). Only post-prefix stream output is
  losable.

## Unsafe-Assumption Register (consolidated)

1. Assuming `append` ⇒ crash-durable (violates write-behind model).
2. Assuming absent result ⇒ operation failed (synthetic isError is a recovery
   convention; Boundary C/D).
3. Assuming generation==0 ⇒ workspace pristine (bash/nested/unknown-effect
   gaps; experiments E/A/H).
4. Assuming historical PASS ⇒ current validity (world drift).
5. Assuming rebuilt generation equals live-generation semantics (non-equivalent
   writer domains; replacement doubling).
6. Assuming no-Orcana-consumer ⇒ irrelevant (request/header, end-seed cases).
7. Assuming repair codes reveal WHEN the crash happened (they reveal only
   which bytes survived).
8. Assuming a steered next-step message survived (inbox-only until claimed).
9. Assuming EngineSnapshot/snapshot-like surfaces are restorable checkpoints
   (composite projections, zero writers).
10. Assuming background job completion/absence from history (registry is
    process-local).

## Completion-Impact Summary

False-confidence pathways identified (analysis only): stale-PASS resurrection
via unknown-outcome mutation (I.2); spurious failing-verification steering via
unknown→FAIL (I.3); replacement double-application shifting generation (G/J);
settlement pollution distorting first-round ladder decisions (J). All flow
through documented projection gaps; all resolutions ultimately require either
world observation or later-phase design decisions. Nothing here declares any
current behavior incorrect-by-contract — R0-D owns contracts.

## Known / Conditional / Unknown Totals

- KNOWN: checkpoint barrier effects (A2/B3/B4, pre-step); repair codes'
  byte-level premises (B1/B2/C); synthetic closer shapes; end-seed producer &
  creation-materialization path; header materialization; code-mode producer
  vocabulary & fields; write-behind/flush contract.
- CONDITIONALLY KNOWN: any single record's survival between append and next
  barrier; replacement durability (compaction point 3); resume-added end-seed
  drain.
- UNKNOWN: interrupted-execution world effects; background eventual outcomes
  absent job-tool queries; downtime world drift.
- UNRESOLVED: orphan `compaction/prune` tolerance; resume-added end-seed drain
  timing; cross-reader visibility of live-only markers.
- REQUIRES WORLD OBSERVATION: all Boundary C/I/M world questions.

## Evidence Index

| Claim | Source | Location |
| --- | --- | --- |
| Checkpoint barriers (LLM/top-level/pre-step/nested) fail-closed | session-checkpoint-policy/src/index.ts @15148dbd9a | full file |
| Write-behind window (200ms) + flush barrier | coordinator.ts:29–33; write-behind.ts:22–72 @15148dbd9a | verified |
| Ordinary call producer | agent-loop tool-calls.ts:250–265 @15148dbd9a | verified |
| Nested vocabulary + fields | tools/src/code-mode.ts:504–541 @15148dbd9a; README:123 | verified |
| Repair codes/premises/closer shape | core/session/src/repair.ts @15148dbd9a; behavioral lock session/tests/repair.spec.ts:50–261 | verified |
| Resume ordering (prepare→repair→commit→reread→publish→session-start) | coordinator.ts:720–768,892–957; agent-loop index.ts:556–568 @15148dbd9a | verified (R0-A carried) |
| requestHeader fold + buildRequest consumption + resume/change append | session/src/index.ts:657–680; agent-loop agent.ts:413–467 @15148dbd9a | verified |
| end-seed producer + lazy creation + seed persist | session/src/index.ts:539–547; coordinator.ts:645–658,1283–1293 @15148dbd9a | verified |
| end-seed compaction consumers | compaction-basic region.ts:286–300,517–552 @15148dbd9a | verified |
| Background ack/jobs/outcome vocabulary | shell/tool-bash/src/index.ts:71–73; tool-bash/background.ts:16–36 @15148dbd9a | verified |
| Pruner adjacency (prune+replacement synchronous) | compaction-tool-result-pruner/src/index.ts @15148dbd9a | verified |
| Steer/stop-path; inbox-claim durability | agent-loop agent.ts:120–132,281–284,295–301 @15148dbd9a | verified |
| Governor fold-before-append ordering | dsh-tools index.js:3359–3388 + agent-loop appendToolResult flow | verified |
| Orcana projection behaviors (FAIL-downgrade, frozen-gen, double-apply, pollution) | experiments /tmp/r0a-{rev3,experiment,experiment2}.mts; suites 42+11 PASS | executor-runtime-proven |
| NO resume-path behavioral test in Orcana repo | grep dsh-governor tests | 0 hits |

NO TARGETED BEHAVIORAL TEST LOCATED (within this repository) for: crash-timing
sub-state discrimination (Boundary D), orphan `compaction/prune` fold
tolerance, resume-added end-seed drain timing. DSH-monorepo specs cited above
cover repair codes, checkpoint policy, jsonl/persistence, request
reconstruction.

## Scope Statement

Docs-only. Runtime, DSH, tests, configs untouched. Every defect/gap named is
recorded for later phases; nothing implemented, fixed, or designed. Next phase
(R0-D) owns invariant/contract decisions — none preempted here.
