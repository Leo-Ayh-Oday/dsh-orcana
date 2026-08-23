# R0-C — Crash Boundary & Ambiguity Analysis (Rev.4)

Answers, for each semantically distinct lifecycle boundary: what is already
durable, what may be durable, what remains unknown, what can be reconstructed,
what requires world re-observation, and what recovery logic must never assume.

Docs-only failure-boundary analysis over current real sources. No recovery
implementation, no new durability machinery, no dedupe/replay/fix of any kind.
Defects found are documented, not repaired.

Rev.1 corrects per independent audit (`REVISE_R0_C`): a durable marker does
NOT prove its execution started (`tool/call` durable ≠ body started;
`tool/code-dispatch-start` durable = pipeline ENTRY recorded only);
TOOL_OUTCOME_UNKNOWN covers indistinguishable RECOVERY-OBSERVATION
ground-truth families (pre-body incl. cooperative-abort-loss / during-body /
post-body-result-lost) — defined by recovery observation; cooperative
abort separated from hard crash; ordinary-path fold-before-append marked
UNREACHABLE-to-invert vs final-result-bypass REACHABLE; verification→mutation
survival rewritten as a contiguous-prefix lattice with execution-domain
distinction; post-steer four-stage
ladder added (incl. the claimed-but-not-appended KNOWN LOSS WINDOW); background
automatic completion-notice path added; end-seed persistence rewritten as
attachPrepared direct-suffix persistence bounded by the BACKEND COMMIT POINT
(not Promise resolution); orphan-prune Surface behavior upgraded to KNOWN.

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

## Crash Model (Rev.3)

Two failure models with DIFFERENT durability guarantees — never conflate:

- **Process death** (SIGKILL / runtime termination; OS and machine remain
  alive): everything already written to the filesystem — including a linked-
  but-not-yet-dir-fsynced artifact (S1) — REMAINS visible and readable.
  In-memory state is lost.
- **Machine / power loss**: durability depends on fsync guarantees; artifacts
  published without their directory-entry fsync (S1) may be lost entirely.

The program's recovery focus (restart after process death) means S1 artifacts
ARE usable there; only the stronger power-loss model requires S2. Every
durability statement in this document should be read against the model it
cites.

## Master Crash Boundary Table (summary)

| ID | Boundary | Guaranteed-durable once past | Conditionally durable | Non-durable/process-local | Repair interpretation | World ambiguity |
| --- | --- | --- | --- | --- | --- | --- |
| A | LLM request prefix vs dispatch | after flush: full logged request prefix | header/request records between append and flush | in-flight stream chunks beyond committed log | n/a (no tail synthesis for headers) | none directly |
| B | top-level call record vs body start | after flush RETURNS: the `tool/call` | the call between append and flush-return (write-behind race) | scheduler-preparation state | race selects NOT_STARTED vs OUTCOME_UNKNOWN; OUTCOME_UNKNOWN does NOT imply body started | body-start possible ONLY after flush returns + signal check passes |
| C | top-level call durable → no durable completed result | the `tool/call` (crossed barrier) | partial output text (process-local); cooperative-abort outcome (generated ≠ durably surviving) | everything execution-local | TOOL_OUTCOME_UNKNOWN synthetic result; body-start UNKNOWN from history | YES — side effects MAY have occurred |
| D | result appended → durability timing | depends on sub-state (D1/D2/D3) | THE RESULT ITSELF | post-execute derived governor state | absent result ⇒ OUTCOME_UNKNOWN even if body completed | possible completed-but-unrecorded |
| E | result durable, Orcana state stale | result | none extra | ALL Orcana engine/adapter state | n/a (result already in history) | inherited from result's own ambiguity status |
| F | code-mode nested lifecycle | outer run_code `tool/call` (post-barrier) | `-start`/`-dispatch` records individually | worker memory / intermediate values | NO synthetic closers for nested records; `-start` durable = pipeline ENTRY recorded (body may never have run) | YES per unresolved sub-dispatch |
| G | mutation result observed | the mutation result (once durable) | pre-barrier window | live generation increment | rebuilt gen tracks only SURVIVING visible mutations | workspace truth ≠ generation |
| H | verification result observed | the verification result (once durable) | pre-barrier window | receipt in engine map | unknown-outcome verifications project FAIL | present validity needs world |
| I | PASS → later mutation → crash | prefix lattice L0/L1/L2 (L3 UNREACHABLE); execution-domain witness table separates ordinary vs nested/live-only vs bash domains; L2 staleness correct ONLY IF replay-visible | projection gaps may freeze/miscount rebuilt generation | derived staleness view | repair may freeze generation ⇒ stale-PASS resurrection | HIGH — freshness unknowable without observation |
| J | mid-turn heuristic settlement | steer messages at Stage-4 (durable) ONLY — see four-stage ladder | Stages 1–3 of the steer message itself | TurnState/ring/chain/budget/inbox entries | settlements leave NO durable trace; steer loss window = KNOWN | none directly |
| K | before completion decision | prior durable facts only | none | violation set, guard decision | recomputed next stop | as per underlying evidence |
| L | completion facts produced → dies pre-exit | the verification/fact records | any unbarriered appends | the "allowed" decision (never durable) | recomputed | per underlying facts |
| M | background/interruptible op | dispatch ack (ordinary result); terminal status/detail ONCE the automatic completion notice reaches Stage-4 | full output (needs explicit job_output); notice Stages 1–3 | ctx.jobs registry; unclaimed notices | no dedicated repair | outcome unknown w/o query/world; graceful-disposal vs hard-death differ |
| — | producer topology note: five tool/result producers exist (ordinary/final-result/skipped-call/repair-closer/replacement) with per-producer fold reachability — see Producer Reachability table | | | | | |

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

## Boundary B — Before Top-Level Tool Execution (REVISED)

Verified chain (checkpoint-policy :70–76): `tools/execute` listener (top-level
only) → `await session.flush()` → **flush returns** → abort/signal check →
`next()` → scheduler prepare/dispatch → tool body.

Sub-states:

- **B1 — assistant block durable, `tool/call` NOT appended**: repair emits
  synthetic result with `TOOL_NOT_STARTED` (repair.spec.ts:50–81). For the
  ordinary top-level path: no durable call ⇒ the flush gate had not passed ⇒
  **body could not have started** (premise scoped to this verified path).
- **B2 — call appended, flush NOT returned**: call CONDITIONALLY durable
  (write-behind race). Repair code depends on surviving bytes: survived ⇒
  OUTCOME_UNKNOWN; lost ⇒ NOT_STARTED. Body not yet invoked either way.
- **B3a — COOPERATIVE ABORT after flush — TWO durability branches**: signal
  aborted at the post-flush check ⇒ `abortedBeforeDispatchResult()` is
  GENERATED (policy :43–49); the loop's cancel path likewise GENERATES
  skipped-call call+result pairs (tool-calls.ts:248–259). Generation is
  process-local; the outcome becomes recovery-visible ONLY if its
  `tool/result` record enters the crash-surviving durable prefix:
  - **B3a-durable**: abort result appended AND persisted ⇒ recovery observes
    an explicit aborted-before-dispatch result (ordinary result semantics).
  - **B3a-lost**: crash before the abort result survives ⇒ recovery sees only
    the durable call with no completed result ⇒ classified
    TOOL_OUTCOME_UNKNOWN like any other. **Generated outcome ≠ durably
    surviving outcome**; cooperative-abort behavior proves nothing about
    hard-crash semantics.
- **B3b — HARD CRASH after flush returns, before body invocation**: call is
  GUARANTEED durable; body NEVER ran; NO result will ever exist. Post-resume
  this is indistinguishable from B4-with-lost-result — all collapse into
  TOOL_OUTCOME_UNKNOWN. This legal boundary is why **durable call ≠ body
  started**.
- **B4 — body begins** (flush returned AND signal check passed): world effects
  become possible → Boundary C applies.

TOOL_OUTCOME_UNKNOWN = RECOVERY OBSERVATION: durable ordinary `tool/call` +
no durable completed `tool/result`. Illustrative reachable ground truths on
the ordinary top-level path (all INDISTINGUISHABLE from surviving history;
not an exhaustive count):

1. PRE-BODY hard crash between flush-return and body invocation (B3b);
2. PRE-BODY cooperative abort whose generated abort outcome did not
   durably survive (B3a-lost);
3. crash DURING body execution;
4. body completed but its result was appended-and-lost (Boundary D1) or never
   appended.

`TOOL_OUTCOME_UNKNOWN = ordinary tool/call survived AND completed result did
not survive.` It is NOT proof the body started.

## Boundary C — Body Began, No Durable Result (core ambiguity)

Facts (RECOVERY OBSERVATION): `tool/call` belongs to the crash-surviving
prefix (KNOWN durable); no completed `tool/result` belongs to it. These two
observations are ALL that recovery knows.

- Recovery CAN observe: the call was durably recorded; no completed outcome
  durably survived.
- Recovery CANNOT prove: that the body ever began. The observation is equally
  compatible with pre-body, during-body, and post-body ground truths (below).
- Recovery CANNOT prove: WHICH ground truth produced the missing result;
  whether the operation mutated anything; how far it got.
- Illustrative ground truths compatible with this observation (examples, not
  an exhaustive count):
  (1) PRE-BODY hard crash after flush-return but before body invocation;
  (2) PRE-BODY cooperative abort whose abort outcome was generated but did
      not durably survive;
  (3) DURING-body crash;
  (4) POST-BODY completion whose result record did not survive (Boundary D1).
  Recovery history cannot distinguish these.
- Repair emits: synthetic `tool/result`, isError=true, error identity
  `ToolOutcomeUnknownError/TOOL_OUTCOME_UNKNOWN`, model-facing text instructing
  verify-then-retry (repair.ts:100–121; behavioral lock repair.spec.ts:229–261).
- World: side effects **MAY have occurred** (UNKNOWN — every illustrative
  ground truth above is history-indistinguishable; even a completed outcome's
  record may have been lost with the result). Absence of durable success ≠
  proof of failure; the synthetic isError=true is a RECOVERY CONVENTION, not
  an observed outcome.
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
of a genuine unknown (documented; not repaired here). See also the E-split:
for ordinary results the loss window after fold is UNREACHABLE; for
final-result bypass records there is no live fold at all.

## Boundary E — `tool/result` PRODUCER TOPOLOGY & fold reachability (REVISED)

Core principle (Rev.3): **"a durable `tool/result` exists while the equivalent
prior live Orcana fold did not happen" cannot be answered globally from the
event type alone — reachability depends on the actual producer path.** Same
Session event type ≠ same live lifecycle producer.

Rev.4 correction: fold OCCURRENCE and fold EQUIVALENCE are separate axes, and
Producer A's own fold can be non-final (see three-axis model below).

### Producer reachability table (REV.4)

| # | Producer / subtype | Event | Post-execute phase invoked? | Orcana listener definitely reached? | Intermediate live fold possible? | Final durable result equivalent to folded result? | Body definitely ran? | Body definitely did NOT run? | World side-effect status | Direct Session append? | Recovery-only? | Replay projection today |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | Ordinary execution — body dispatched, completes normally | tool/result | YES | CONDITIONAL ON LISTENER REACH/ORDER/COMPOSITION (an earlier waterfall listener may short-circuit/block/throw without calling next()) | YES when reached — Orcana folds BEFORE await next() (:467–474) | **NOT GUARANTEED** — downstream accept-content/value replacement, block→isError conversion, or definition-owned finalizeContent can all change the fact AFTER the fold | YES (bodyInvoked=true before execute) | no | outcome known as-folded; final durable fact may differ | no (loop appends via appendToolResult :155) | no | folds again from durable record |
| A2 | Prepare-stage denial/cancel (guard denial, ask-cancel, pre-dispatch abort) | tool/result (post-result kind at PREPARE stage) | YES — still routed through finalizeScheduledExecution | same CONDITIONAL | YES when reached | NOT GUARANTEED (same downstream powers) | **NO — body never dispatched** | YES | none from this call | no | no | folds again |
| B1 | PREPARE-STAGE final-result (collapsed-direct-call denial, signal-abort-before-dispatch, argument snapshot TypeError, callerCancelled) | tool/result | NO — finish() skips it | n/a | none | n/a (no fold to compare) | **NO — dispatch/body never reached** | YES | none | no (loop appends via finish path, tool-calls.ts :153) | no | first Orcana observation at rebuild |
| B2 | DISPATCH-STAGE final-result (error thrown inside tools/execute waterfall scope — INCLUDING an around-wrapper throwing AFTER the body completed, or result-normalization failures; index.js :3191–3212 catch) | tool/result | NO | n/a | none — but the BODY MAY HAVE COMPLETED before the throw | n/a | **NOT PROVABLE — body may or may not have run** | NO | UNKNOWN (body side effects possible) | no | no | first Orcana observation at rebuild |
| C | Skipped-call synthetic abort pair (loop cancel path) | call+result appended directly | NO | n/a | none | n/a (single writer) | NO — never prepared/dispatched | YES | none | YES — direct consecutive appends (:248–259); survival still write-behind/barrier-governed | no | pairs normally |
| D1 | Cold-repair synthetic — TOOL_OUTCOME_UNKNOWN | synthetic tool/result | NO | n/a | none in dead process; resumed rebuild folds it FIRST (identity loss ⇒ may project FAIL) | n/a | UNKNOWN (three ground states) | no | UNKNOWN | YES — durable via commitRepair before resume | **YES** | pairs with pending call ⇒ 1 EngineEvent |
| D2 | Cold-repair synthetic — TOOL_NOT_STARTED | synthetic tool/result | NO | n/a | none | n/a | **NO — no durable call by definition** | YES | none | YES — durable via commitRepair | **YES** | ✗ ZERO EngineEvents — orphan-skip (repair Session fact ≠ Orcana projection consumed) |
| E | Compaction surface replacement | tool/result (surfaceOp replace) | NO | n/a | none — pruner appends directly to raw log; no live body post-execute fold for the replacement itself | n/a | n/a | n/a | n/a | YES — direct raw-log append | no | double-application risk (J) |

Physical durability caveat applies to ALL producers: appended ≠ necessarily
crash-surviving (write-behind/barrier/backend-commit govern survival).

### Producer-A three axes (REV.4)

- **Axis A — post-execute phase invoked**: YES for ordinary scheduler
  executions (and also for prepare-stage denials, A2).
- **Axis B — Orcana listener actually reached/folded**: **CONDITIONAL ON
  LISTENER REACH/ORDER/COMPOSITION** — the post-execute waterfall lets any
  earlier listener return a decision WITHOUT calling next(), which ends the
  chain before later listeners; Orcana folds iff its listener is invoked
  (:460–484, fold precedes `await next()`).
- **Axis C — fold equivalent to FINAL durable result**: **NOT GUARANTEED.**
  After the fold, downstream middleware may block (isError+feedback),
  replace content or value, and definition-owned `finalizeContent`
  (`applyFinalContent`, dsh-tools :3034–3036 contentFinalizers) transforms
  content before materialization.

Verified conceptual sequence for Producer A:

```
text
body / execution result
 ↓
tools/post-execute waterfall:
   earlier listeners…
   ORCANA applyEvent(intermediate result)   ← fold point (if reached)
   await next()
   downstream: accept / replace content|value / BLOCK→isError
 ↓
finishScheduledExecution()
 ↓
applyFinalContent() / definition-owned finalizeContent
 ↓
appendToolResult → final tool/result appended
 ↓
persistence (write-behind / barrier)
```

### Producer-A semantic counterexample (source-supported)

Successful mutation: workspace mutation actually succeeds → Orcana folds
success → generation += 1 → downstream BLOCKS/replaces the final result →
durable final result isError=true → restart replay: mutation=false ⇒
generation does NOT advance ⇒ **live generation ≠ rebuilt generation** — with
an ordinary ROOT tool, no code-mode, no result loss, fully durable result, no
compaction replacement. Verification analogue: live receipt PASS → downstream
content replacement/finalizer alters the rendered text (possibly destroying
exit-status markers) → rebuilt receipt FAIL/different status.

Boundary-E crash consequence per producer: A — no ambiguity beyond which
records survived (D-family); B/C/D/E — a durable result can exist that the
live process NEVER folded, so post-resume rebuild is its FIRST Orcana
observation, and any pre-crash derived-state continuity claim for that fact is
unfounded.

No other `tool/result` producer was located in rc.6 sources (repair closers,
skipped-call pairs, pruner replacement, scheduler ordinary/bypass are
exhaustive for this audit).

Ordering note (qualified): on the ORDINARY path the governor folds results at
post-execute BEFORE the loop appends the result, so durable ordinary results
were necessarily already folded live; final-result bypass records reach the
log WITHOUT any live fold (see E-split).

## Boundary E — Durable Result, Orcana Process State Not Updated

Given a durable result: rebuild deterministically re-derives generation /
receipts / ring over the replay-visible stream (R0-B), TurnState comes back as
a polluted aggregate, chain resets to 0, budget resets. The crash-specific
consequence is limited to WHICH results survived (Boundaries C/D) — the
derivation itself adds no new ambiguity beyond the known projection gaps
(code-dispatch drop, replacement double-application, unknown→FAIL). No
taxonomy restated here per scope.

## Boundary F — Code-Mode Nested Execution (REVISED)

Vocabulary (producer-verified): outer `run_code` = ORDINARY root `tool/call`;
each launched nested operation appends `tool/code-dispatch-start`
{rootCallId,parentCallId,subCallId,name,arguments} at PIPELINE ENTRY
(code-mode.ts:535–541), then `scheduler.prepare` (guards/pre-execute) →
`dispatch` (body) or a pre-body final-result → commit-time `finalize/finish` →
settle appends `tool/code-dispatch` (+isError,content; :510–521,
:543–577). Queued-and-abandoned operations log NEITHER.

**`-start` durable ⇒ nested pipeline ENTRY was recorded. It does NOT prove the
nested body ran**: after `-start`, the pipeline may crash during prepare /
guards / pre-execute (body never runs), or the body may run with its
settlement record lost. History cannot distinguish:

- **F1 — `-start` not durable, no settle**: raw shows outer call only;
  nothing provable about the nested op (body may never have launched).
- **F2 — `-start` durable, settle absent**: sub-dispatch ENTRY proven
  (name/args known); body-ran vs never-ran UNKNOWN; outcome UNKNOWN.
  Repair emits NO synthetic closer for nested records (repair scans
  tool/call only).
- **F3 — start+settle durable**: nested outcome (isError/content) proven;
  still dropped by Orcana replay filter (gap stands).
- **F4 — outer result absent**: outer dangling → TOOL_OUTCOME_UNKNOWN closer
  (with all Boundary-C ground-state caveats); inner records still filtered;
  compound ambiguity.

World status for F1/F2: side effects UNKNOWN unless another durable fact or
world observation resolves them. Nesting identity survives IN RAW HISTORY
(rootCallId/parentCallId/subCallId) but has no representation in Orcana
EngineEvent.

## Boundary G — Mutation Result Observed

Once a successful mutation result is durable: live generation already advanced
(fold precedes append); rebuild advances identically IF the record stays
replay-visible AND the folded intermediate fact matched the finally-persisted
fact. Known divergences that break equality: nested code-mode mutations
(dropped — gen under-counts), surface replacement second application (gen
OVER-counts, experiment J), unknown-outcome mutations (never counted — H),
and **Producer-A finalization mismatch** — a success fold whose final durable
result became isError via downstream block/replace replays as mutation=false
(gen under-count vs live; Rev.4 counterexample). Generation remains a COARSE
DERIVED RUNTIME FACT, never workspace authority; durable-mutation ⇒
correct-generation is NOT a valid inference.

## Boundary H — Verification Result Observed

Verification result durable ⇒ receipt deterministically reconstructable given
verifyPatterns (config input). Receipt says "PASS at generation N historically"
— NEVER "workspace currently valid". TWO caveats: (1) if a crash separated
the verification from subsequent mutations, see Boundary I; (2) Producer-A
finalization divergence can change the durable outcome/text versus what the
live receipt recorded (Rev.4 analogue), so even the SURVIVING receipt may
disagree with the live-era observation. Present validity always REQUIRES
WORLD OBSERVATION or a fresh re-run.

## Boundary I — Verification PASS → Later Mutation → Crash (REV.3: prefix lattice vs execution domain)

Two DISTINCT questions, kept in two separate tables:

1. **Durable-prefix lattice** — which historical Session event combinations
   can survive a crash? (append-only contiguous prefix ⇒ L0/L1/L2 reachable,
   L3 UNREACHABLE — unchanged)
2. **Execution-domain reachability** — given a survivor shape, could a REAL
   side effect have occurred in that world?

### Prefix lattice (unchanged)

`seq(V) < seq(M)`; survivors are exactly one of: **L0** neither / **L1** V only /
**L2** V+M; **L3 = M-only is UNREACHABLE**.

### Execution-domain witness table (REVISED)

| Witness kind | Which prefix states can carry it? | Notes |
| --- | --- | --- |
| Ordinary top-level mutation whose CALL survived durably but RESULT was lost | **L1 ONLY** | `seq(V) < seq(call)` + contiguous prefix ⇒ V necessarily survived too; an L0 witness via ordinary durable mutation call is **UNREACHABLE** |
| Code-mode nested / live-only execution domain (nested op executes; its `-start`/`-dispatch` records fail to survive, or the domain produces no surviving per-mutation marker in required form) | L0, L1, or L2 (independent of V/M survival) | real world effect POSSIBLE inside L0 — an empty durable prefix does NOT prove an unmutated workspace |
| bash-class workspace change | any state | never produces a recognized mutation marker at all (MUTATION_TOOLS excludes bash) |

### Consequences per lattice state

- **L0**: no V, no M in history — but a real mutation MAY still have occurred
  via the nested/live-only or bash domains above ⇒ REQUIRES WORLD OBSERVATION
  before any freshness claim. Do NOT read L0 as "workspace pristine" and do
  NOT invert it into "L0 means nothing happened".
- **L1**: V present; later ordinary-mutation-call-durable-with-lost-result is
  an L1 witness (NOT L0); rebuilt generation frozen at V's generation. Old
  PASS presents CURRENT **CONDITIONALLY**: only if restart-time current
  `verifyPatterns` still RECOGNIZES V's command — otherwise the receipt may
  not be reconstructed at all and no stale-PASS presentation occurs (a
  different failure mode: evidence silently absent). Under the recognized
  case the false-confidence risk stands (experiments A/H) unless world
  observed.
- **L2**: staleness computed correctly ONLY IF M is visible and correctly
  recognized by current Orcana replay projection. QUALIFIER preserved:
  code-mode nested mutations are replay-DROPPED and surface replacements are
  DOUBLE-APPLIED (R0-B D1/D6), so physical prefix correctness ≠ Orcana
  semantic replay completeness. ADDITIONAL divergence (Rev.4): ordinary
  Producer-A intermediate-fold vs final-durable-result mismatch — a live fold
  of success (generation advanced) whose final durable result was converted
  to isError by downstream block/replace or finalizeContent replays as
  mutation=false ⇒ live generation ≠ rebuilt generation even for an ordinary
  root tool with the result fully durable.

If the intended scenario is instead `mutation → later verification → crash`,
that remains a DIFFERENT family analyzed under Boundary H rules with the
generation gaps of G applied.

## Boundary J — Mid-Turn Heuristic / Settlement State (REVISED with post-steer ladder)

Verified lifecycle: settlements occur ONLY inside `agent/turn-stopping`
dispatches (agent.ts:295–296); they emit NO durable record; one DSH turn can
contain many settlements. A steer enqueues to the NEXT-STEP INBOX and reaches
durable Session history only through a FOUR-STAGE ladder:

```text
agent.steer(msg)
 → Stage 1: next-step inbox entry        (process-local)
 → inbox.claim() removes from inbox
 → Stage 2: CLAIMED, not yet appended    (message exists nowhere durable;
   systemPrompt.assemble / agent/pre-step    crash here = KNOWN LOSS WINDOW)
 → step/start append
 → Stage 3: user/message APPENDED to live Session (CONDITIONAL durability:
   write-behind may persist; explicit barrier guarantees)
 → Stage 4: DURABLE (recovery can re-observe it)
```

Crash points and consequences:

| Crash point | Durable | Lost/reset | Stop/continue consequence |
| --- | --- | --- | --- |
| before settlement N | prior round facts only | round observations (ring-rebuildable parts recover; verdict does not) | resume starts chain=0; first settle polluted (proven) |
| after endTurn(), before decideSteer | nothing new | verdict + chain delta | resume recomputes — different ladder position possible |
| after decideSteer(steer), before agent.steer | nothing | decision | resume never steers for that round |
| **Stage 1: after agent.steer, before claim** | steer message itself: NONE (inbox-only) | the steer message | stop that WOULD have been prevented now proceeds |
| **Stage 2: claimed-but-NOT-appended** | **the steer message itself still has NO durable Session representation** (removed from inbox AND user/message not yet appended — **KNOWN LOSS WINDOW**: crash during assemble/pre-step). Other Session facts of this window (e.g., `step/start`) may independently exist/be durable — do not read this row as "no Session fact at all" | the steer message entirely | same as Stage 1 loss, plus the claim already consumed it |
| **Stage 3: appended-but-not-durable** | CONDITIONAL (write-behind may have drained; barrier may not have run) | possibly the user/message record | partial continuity possible |
| **Stage 4: durable** | user/message in persisted prefix | — | continuity restored modulo Barrier-D windows |

Claim ≠ durable message. Preservation correctness value stays
**AMBIGUOUS / UNRESOLVED** (unchanged). No durability mechanism proposed.

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

## Boundary M — Background / Interruptible Operation (REVISED)

Verified shape (tool-jobs/tool-bash rc.6): background bash returns an
immediate ack result (ordinary `tool/result`, job id); settlement lands in a
PROCESS-LOCAL `ctx.jobs` registry (`settle()` records status/detail/output,
jobs-local :416–434). Two separate durability channels exist:

1. **Automatic completion NOTICE** (terminal status/detail):
   `ctx.jobs.onJobDone` listener (tool-jobs/src/index.ts:283–302) builds a
   plugin-source user message and delivers it to the owner Agent:
   busy ⇒ `owner.inject(message)` (waits in next-step inbox); idle+wakeup-
   budget ⇒ `owner.followup(message)` (wakes driver). First-wins semantics
   (`snapshot.reported` guard); disposal before claim DISCARDS the notice;
   teardown settlements arrive pre-`reported`. Once claimed/appended/persisted
   (same four-stage ladder as Boundary J), terminal status/detail IS durably
   represented WITHOUT any explicit job_output call.
2. **Full output**: normally requires an explicit `job_output` tool call
   (its own ordinary call/result record); streaming jobs return incremental
   reads.

Crash stages of the notice itself reuse the Boundary-J ladder: settled →
notice queued (inbox) → claimed → user/message appended → persisted. A crash
before Stage 4 loses the notice even though **the real process/job world has
a terminal outcome** — post-resume Session history cannot pretend to know it
(REQUIRES WORLD OBSERVATION or a fresh job-tool query against the live
registry).

Graceful disposal vs hard death: graceful agent/service disposal CANCELS
owned jobs and awaits termination (observable stopping→settled transitions);
hard SIGKILL leaves children per OS semantics with NO notice path at all.
Do not merge the two.

Historical absence of a job_output query does NOT prove failure, success, or
completion. No exactly-once guarantee exists or is proposed.

## Compaction / Surface-Replacement Timing Family (REV.4: contiguous-prefix states)

Producer sequence (pruner src): prune pass iterates CURRENT-SURFACE results →
for each over-budget node APPENDS `compaction/prune` (shadow price, P) then
IMMEDIATELY-ADJACENT replacement `tool/result` (R; surfaceOp replace +
sourceEventSeqs), with `seq(O) < seq(P) < seq(R)` for original O. Because the
log is a CONTIGUOUS PREFIX, crash-surviving survivor sets are exactly:

| Surviving prefix | Surface after restart | Current Orcana raw replay sees |
| --- | --- | --- |
| O | surface = original node | single application |
| O + P | surface STILL = original node (**KNOWN** — P is log-only, no surfaceOp, not a surface event) | single application (P unconsumed) |
| O + P + R | surface = replacement (shadows O) | DOUBLE application of the same logical result (mutation replacements double generation — J; receipt overwrite for verifications) |
| R without P, or P+R without O | **UNREACHABLE** — contiguous prefix cannot skip or lose earlier seqs while keeping later ones |

Rev.0's "crash loses ONLY the replacement" wording was WRONG (point 3 below
superseded): if R did not survive, the prefix cut may fall before OR after P —
P may survive or be lost with it. The Surface conclusion is UNCHANGED and
KNOWN in every reachable state: whenever R is absent the surface remains on
the ORIGINAL node (P carries no content). Isolated open question:
TOKEN-METER CLAIM STATE across an O+P-without-R cut (metering consumer
semantics outside audited scope; isolated so it does not qualify the Surface
conclusion).

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
   intent (cursor 0, materialized:false — source comment: "Pure lazy: record
   intent only. No artifact until the first append"; physical durability is
   governed by the BACKEND DURABLE PUBLISH/COMMIT POINT — e.g. jsonl
   writeSyncedTempFile → link() publish → dir fsync — NOT by appendCore
   Promise resolution, which may resolve strictly after the artifact is
   already crash-durable); then `if (seed.length > 0) await appendCore(id,
   seed)` persists the whole seed batch — INCLUDING the constructor-appended
   end-seed — via appendBatch/materialize. The materialization path has THREE
   physically distinct states (jsonl materializePosix :529–562):
   - **S0 — pre-link**: `link(tmp, finalPath)` not yet completed ⇒ final
     artifact path ABSENT. Crash here ⇒ session invisible to `list()` and
     unrecoverable-by-id (header intent was memory-only).
   - **S1 — post-link / pre-directory-fsync**: link() SUCCEEDED — the final
     path is PUBLISHED. Under PROCESS DEATH (SIGKILL/runtime termination with
     OS alive) the path EXISTS and is visible/readable — process death does
     not roll back a completed link(). POWER-LOSS durability is NOT YET
     guaranteed: without the parent-directory fsync a machine crash may lose
     the directory entry.
   - **S2 — post-directory-fsync**: the backend's declared POWER-LOSS DURABLE
     publication guarantee is reached ("the new link is not crash-durable
     until the parent directory's metadata is synced", jsonl :557–562).
   Single semantic boundary pair to track: S0→S1 (publication) and S1→S2
   (power-loss durability).

   BACKEND SCOPE (Rev.4): these S0/S1/S2 states describe the CURRENT JSONL
   POSIX `materializePosix` implementation. They are NOT automatically
   applicable to the Win32 publication path, to other persistence backends
   (e.g. sqlite), or to future backend implementations. R0-C records current
   real behavior; it does not define a universal storage contract.
2. **Resume path** (prepareCore :892–931 → attachPrepared :1185–1207): stored
   balanced events seed the constructor; a fresh end-seed is appended ONLY IF
   the stored log does not already end with one. That fresh marker is
   PERSISTED DIRECTLY at prepared-session attach: `attachPrepared` computes
   `suffix = session.events.slice(state.cursor)` — the constructor-added
   end-seed is inside that suffix — and `if (suffix.length > 0)` immediately
   starts `appendCore(id, suffix)`. NO subsequent normal Session write is
   required. The semantic crash boundary is the BACKEND DURABLE COMMIT POINT:
   crash before it ⇒ end-seed may be absent; after it ⇒ end-seed survives.
   NOTE: Promise resolution of appendCore is NOT that boundary — a JSONL
   materialize/append can be durably published (link()+dir-fsync) while its
   Promise is still unresolved; use the backend commit point, not function
   completion.
3. **Compaction consumption timing**: `inspectCompactionEntryState` reads
   end-seed from `session.events` (live view). After attachPrepared the suffix
   persistence covers the marker; cross-reader visibility before the backend
   commit point remains an exact-timing question for R0-C follow-up if ever
   operationally relevant (narrow).

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

## Unsafe-Assumption Register (consolidated; REV.1-corrected)

1. Assuming `append` ⇒ crash-durable (violates write-behind model).
2. Assuming absent result ⇒ operation failed (synthetic isError is a recovery
   convention; Boundary C/D).
3. Assuming generation==0 ⇒ workspace pristine (bash/nested/unknown-effect
   gaps; experiments E/A/H).
4. Assuming historical PASS ⇒ current validity (world drift).
5. Assuming rebuilt generation equals live-generation semantics (non-equivalent
   writer domains; replacement doubling).
6. Assuming no-Orcana-consumer ⇒ irrelevant (request/header, end-seed cases).
7. Assuming repair codes reveal WHEN or WHETHER the body ran (they reveal only
   which bytes survived; OUTCOME_UNKNOWN is compatible with pre-body /
   during-body / post-body ground truths) — includes its corollary:
   **TOOL_OUTCOME_UNKNOWN ⇒ body ran** ❌.
8. Assuming a steered next-step message survived (four-stage ladder: lost at
    Stages 1–2 even after a successful agent.steer call).
9. Assuming EngineSnapshot/snapshot-like surfaces are restorable checkpoints
   (composite projections, zero writers).
10. Assuming background terminal outcome exists ONLY via explicit job_output
    (automatic onJobDone notice may durably carry terminal status/detail;
     full output still requires job_output) ❌-corrected.
11. **durable `tool/call` ⇒ body ran** ❌ (B3b hard-crash window exists).
12. **durable `code-dispatch-start` ⇒ nested body ran** ❌ (prepare/guards/
    pre-execute crash windows exist between start and body).
13. **claimed next-step ⇒ durable user/message** ❌ (claimed-but-not-appended
    KNOWN LOSS WINDOW: other Session facts like step/start may be durable
    while the steer message itself is not).
14. **appendCore Promise unresolved ⇒ artifact absent** ❌ (backend publish /
    dir-fsync may precede Promise resolution; use the backend commit point).
15. **a later event can survive while an earlier-seq event is lost** ❌
    (append-only contiguous prefix; survivor sets are prefix-shaped).
16. **generated abort outcome ⇒ durably surviving abort fact** ❌
    (generated-in-process ≠ persisted; a non-surviving abort result collapses
     into TOOL_OUTCOME_UNKNOWN).
17. Preserved standing rule: absence of durable result ≠ proof side effect did
    not occur.
18. **ordinary durable tool/result always implies prior live Orcana fold** ❌
    (only Producer A; bypass/skipped/repair/replacement producers fold-free).
19. **all tool/result producers share the scheduler post-execute lifecycle** ❌
    (five distinct producer topologies — see Producer Reachability table).
20. **an ordinary later-mutation durable call can coexist with a lost earlier
    verification V** ❌ (contiguous prefix forces L1, never L0).
21. **post-link/pre-dir-fsync artifact is necessarily invisible after
    SIGKILL** ❌ (published path survives process death; only power-loss
    durability awaits dir fsync).
22. **process death == power loss** ❌ (distinct failure models with distinct
    durability guarantees — S1 vs S2).
23. **Orcana fold occurred ⇒ fold equals the final durable result** ❌
    (downstream block/replace and definition-owned finalizeContent can change
     the fact after the fold; Producer-A axes B/C).
24. **ordinary post-execute path ⇒ downstream cannot change the result** ❌
    (same mechanism as #23).
25. **final-result ⇒ body never ran** ❌ (DISPATCH-STAGE final-result can
     follow a completed body via around-wrapper post-body throws or
     normalization failures; only PREPARE-STAGE final-result proves that).
26. **durable repair result ⇒ Orcana rebuild necessarily consumes it** ❌
    (D2/TOOL_NOT_STARTED closers orphan-skip to zero EngineEvents).
27. **L1 V-only ⇒ verification receipt necessarily rebuilds** ❌
    (requires restart-time verifyPatterns to still recognize V's command).

## Completion-Impact Summary

False-confidence pathways identified (analysis only): stale-PASS resurrection
via unknown-outcome mutation (Boundary I lattice, survivor state L1);
spurious failing-verification steering when a verification outcome falls into
crash ambiguity — that finding belongs to the `mutation → later verification`
family (Boundary H projection rules with generation gaps of G applied), not to
the PASS→mutation lattice; replacement double-application shifting generation
(G/J); settlement pollution distorting first-round ladder decisions (J). All
flow through documented projection gaps; all resolutions ultimately require
either world observation or later-phase design decisions. Nothing here
declares any current behavior incorrect-by-contract — R0-D owns contracts.

## Known / Conditional / Unknown Totals

- KNOWN: checkpoint barrier effects (A2/B3/B4, pre-step); repair codes'
  byte-level premises (B1/B2/C); synthetic closer shapes; end-seed producer &
  creation-materialization path AND attachPrepared direct-suffix persistence;
  header materialization; code-mode producer vocabulary & fields; write-behind/
  flush contract; orphan-prune Surface behavior (log-only ⇒ surface stays
  original); ordinary-path fold-before-append ordering; five-producer
  tool/result topology and per-producer fold reachability; prefix lattice
  L0/L1/L2 reachable + L3 unreachable; S0/S1/S2 end-seed physical states.
- CONDITIONALLY KNOWN: any single record's survival between append and next
  barrier; replacement durability (compaction point 3); steer-message survival
  (Stages 1–3 of the ladder); OUTCOME_UNKNOWN ground-state identity.
- UNKNOWN: interrupted-execution world effects and ground states; background
  eventual outcomes absent Stage-4 notices/job-tool queries; downtime world
  drift; token-meter claim state across orphan prunes.
- UNRESOLVED: token-meter claim-state semantics (isolated); deployed-version
  equivalence.
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
| end-seed attachPrepared direct-suffix persistence; backend commit point vs Promise resolution | coordinator.ts:1185–1207 (storedCursor/slice/appendCore); jsonl materializePosix :529–562 (writeSyncedTempFile → link() publish → dir fsync → cleanup) | verified |
| end-seed compaction consumers | compaction-basic region.ts:286–300,517–552 @15148dbd9a | verified |
| S0/S1/S2 physical states: pre-link absent; post-link published/process-death-visible; post-dir-fsync power-loss durable | rc.6 jsonl materializePosix :529–562 (link-then-syncDir sequence + comments) | SOURCE-PROVEN; NO TARGETED TEST LOCATED for the S1-vs-S2 distinction specifically |
| Five tool/result producers + fold reachability | tool-calls.ts :146–160,:248–259; coordinator :892–957; pruner src | producer-path verified per row |
| end-seed compaction consumers | compaction-basic region.ts:286–300,517–552 @15148dbd9a | verified |
| Background ack/jobs/outcome vocabulary | shell/tool-bash/src/index.ts:71–73; tool-bash/background.ts:16–36 @15148dbd9a | verified |
| Pruner adjacency (prune+replacement synchronous) | compaction-tool-result-pruner/src/index.ts @15148dbd9a | verified |
| Steer/stop-path; four-stage steer ladder incl. claimed-but-not-appended loss window | agent-loop agent.ts:120–132, :281–284 (claim), :295–301 @15148dbd9a | verified |
| Governor fold-before-append ordering (ordinary path); final-result bypass | tool-calls.ts:146–160 (finalize→appendToolResult; needsPost=false→finish) + dsh-tools index.js:3002,:3223–3225,:3359–3388 | verified |
| Automatic completion notice: onJobDone → inject(busy)/followup(idle+wakeBudget); first-wins; disposal discards | rc.6 jobs/tool-jobs/src/index.ts:283–302; jobs-local settle() :416–434 | verified |
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
