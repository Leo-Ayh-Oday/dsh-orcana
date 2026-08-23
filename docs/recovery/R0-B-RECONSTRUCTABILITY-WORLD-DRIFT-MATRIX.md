# R0-B — Reconstructability & World-Drift Matrix (Rev.1)

Classification of every recovery-relevant state/fact identified in R0-A
(`docs/recovery/R0-A-RECOVERY-STATE-INVENTORY.md`, accepted `215595e`).
Answers: what is durable, what is derived, what is resettable, what must be
re-observed, what remains unknown. Not a correctness contract, not R0-C
crash-boundary analysis, not a recovery design.

**Rev.1** revises per independent audit (`REVISE_R0_B`):

1. A-class durability definition corrected — a Session event is NOT,
   unconditionally, crash-surviving; durability requires crossing the
   applicable persistence/checkpoint boundary (rc.6
   `session-checkpoint-policy`, read this pass — semantics below).
2. Steer mental model corrected — `agent.steer()` inserts into the next-step
   inbox and CAN flip DSH stop→continue; reset-safety claims that assumed
   "steer only adds text" are withdrawn; preservation-correctness values for
   chain/TurnState/ring downgraded to AMBIGUOUS / UNRESOLVED.
3. Orcana config/runtime-composition classified; config-sensitive derived
   states marked `Session-history-alone = NO`.
4. Pure completion violations separated from effective stop/continue outcome;
   forced-budget skip path documented.
5. Forced-steer raw-material durability claim made conditional (inbox window).
6. EngineSnapshot given its own row; checkpoint unknowns split into KNOWN vs
   UNRESOLVED.

Rev.0 conclusions that survive are kept (World-Drift and Projection-Loss
matrices preserved with narrow additions only).

## Baseline

- Branch: `research/durable-recovery-r0-b`; starting HEAD
  `3d872ae4d1a7e853d7f19a389bc92fffba8ed2bd` (audited Rev.0); accepted R0-A
  base `215595e` is ancestor; worktree clean.
- Source seams unchanged since audited state (`git diff --stat 215595e --
  packages/ benchmark/` empty).
- Lockfile basis: `@deepseek-ai/dsh-*` 0.1.0-rc.6. NEW primary evidence this
  pass: rc.6 `packages/session/session-checkpoint-policy/src/index.ts` (full
  read) and rc.6 `agent-loop/src/agent.ts` send/steer/stop-path lines.
- Fresh verification this pass: governor-core core+p2 specs 2 files /
  42 tests PASS; dsh-governor adapter.spec 1 file / 11 tests PASS;
  coverage check: **no test drives `session-start` resume or compares
  stop/continue across a simulated restart** (grep count 0) — reset-safety
  remains UNPROVEN by tests, as stated below.

## A. Classification Legend (Rev.1)

- **A. authoritative native durable fact** — a fact whose authoritative owner
  is DSH Session/native runtime AND which, **for a particular recovery point,
  belongs to the persisted/reloaded crash-surviving durable prefix under the
  applicable persistence/checkpoint semantics**.

  Governing equation (replaces Rev.0's unconditional "survives restart by
  construction"):

  > authoritative Session fact **+** crossed the applicable
  > persistence/checkpoint boundary **=** authoritative durable fact
  > available to recovery

  Membership in the LIVE `session.events` array alone does NOT imply
  reloadability after an arbitrary crash.
- **B. deterministic derived state** — fully determined by (authoritative
  inputs) + deterministic algorithm, where the input set must be stated
  exactly. If current runtime/config is an input, then it is NOT
  Session-history-alone.
- **C. derived optional / heuristic state** — lossy/heuristic mechanisms for
  behavior quality. Their PRESERVATION-CORRECTNESS VALUE is assessed
  separately and honestly (several are AMBIGUOUS / UNRESOLVED — see
  Reset-Safety).
- **D. ephemeral turn / process state** — process-local containers or
  round-scoped accumulators.
- **E. external world state requiring observation** — no amount of Session
  history proves current values.
- **F. ambiguous / unresolved** — blocked on missing evidence; recorded, not
  guessed.

Standing distinctions enforced everywhere: *fact exists durably* ≠ *Orcana
reconstructs it correctly*; *runtime-derived truth* ≠ *actual world truth*;
*event ∈ live session.events* ≠ *event ∈ persisted/reloadable prefix*.

## A0. KNOWN Checkpoint Semantics (rc.6, source-verified this pass)

From `session-checkpoint-policy/src/index.ts` (rc.6 @15148dbd9a, full file):

| Boundary | Verified behavior |
| --- | --- |
| LLM request | `llm/stream` wrapper: `await ctx.sessions.flush(session)` completes BEFORE the downstream adapter stream yields its first chunk; "the complete logged request prefix [is] durable"; fail-closed — checkpoint rejection prevents adapter dispatch |
| Top-level tool | `tools/execute` listener (applies ONLY when `exec.agent !== undefined && exec.parent === undefined`): flush AFTER the tool/call is recorded, BEFORE the tool body runs; fail-closed — aborted-before-dispatch error result on rejection |
| agent/pre-step | flush BEFORE each next step — persists everything committed by the preceding step |
| Nested dispatch | `exec.parent !== undefined` → NO independent checkpoint; nested dispatches reuse the durable outer call |

Direct consequences used below: **if a top-level tool body has truly begun,
its top-level `tool/call` has already crossed its checkpoint**; a just-
appended `tool/result` has NOT necessarily crossed any boundary yet; nested
records' durability rides the outer call plus whichever later batch flush
covers them.

## B. Reconstructability Matrix

Columns: State/Fact · Owner/Src · Class · InLiveSession · Auth · Durability/
checkpoint condition · InCrashSurvivingPrefix · HistoryAlone · ExtraInput ·
RebuiltToday · WorldObs · PreserveCorrectnessValue · ResetConsequence ·
Evidence. (`HA=NO` marks Session-history-alone = NO.)

### A-class rows

| State/Fact | Owner/Src | Cls | LiveSess | Auth | Durability condition | InDurablePrefix | HistAlone | ExtraInput | RebuiltToday | WorldObs | PreserveVal | ResetConseq | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Session identity/header | DSH | A | yes | yes | crosses boundaries like any record; header reloaded by persistence | per policy | n/a | n/a | n/a (unused by engine) | no | n/a | none | dsh-session types |
| user/task messages | DSH (user/message) | A | yes | yes | appended WHEN driver claims messages into a step (agent-loop agent.ts:283); durable after a SUBSEQUENT applicable boundary (pre-step :79–82 / next top-level tool :70–76 / next request :35) | CONDITIONAL (post-append, pre-flush window) | n/a | n/a | not folded into engine state; interjection reset reads live inbox sources | no | n/a | n/a | checkpoint-policy src; agent.ts:283 |
| assistant/message incl. tool requests | DSH | A | yes | yes | same conditional pattern (step-lifecycle append; later boundary flushes) | CONDITIONAL | n/a | n/a | requests unconsumed by engine; provenance for TOOL_NOT_STARTED repair | no | n/a | n/a | repair.ts:44–48 |
| tool/call — TOP-LEVEL | DSH | A | yes | yes | recorded → checkpointed BEFORE tool body (policy :70–76); **if body truly began, the call HAS crossed its checkpoint** | YES once body started; before that, per general batching | n/a | n/a | YES when paired | no | inherent (already durable-by-boundary) | n/a | policy src; audit-mandated reading |
| tool/call — NESTED | DSH | A | yes | yes | NO independent checkpoint (parent≠undefined skips :71–72); rides outer call's durability + later batch flushes | CONDITIONAL | n/a | n/a | filtered out of replay feed anyway | no | inherent | n/a | policy :71–72 |
| tool/result | DSH | A | yes | yes | appended post-execution; NO dedicated result checkpoint; enters durable prefix at the NEXT applicable boundary (pre-step/request/top-level-call) | CONDITIONAL — immediate crash after append can lose it | n/a | n/a | PARTIAL (hash/isError-default caveats) | no | inherent | n/a | policy (absence of result hook); types 299–310 |
| tool/code-dispatch records | DSH bridge | A | yes | yes | nested ⇒ NO independent checkpoint; covered by later batch flushes | CONDITIONAL | n/a | n/a | ✗ dropped by replay filter | no | inherent | n/a | policy :71–72; CodeDispatchLog :239–252 |
| Synthetic recovery events (closers) | DSH persistence | A | yes | yes | created BY the cold-repair commit itself (`commitRepair`) — durable at creation, before resume proceeds | YES once repair committed | n/a | n/a | PARTIAL (pairing survives; identity lost — G) | no | inherent | n/a | coordinator :892–957; repair.ts |
| TOOL_OUTCOME_UNKNOWN identity | DSH repair layer | A | yes | yes | durable with its synthetic result (above) | YES once repair committed | n/a | n/a | WEAKENED — code dropped; UNKNOWN→FAIL (G) | no | inherent | n/a | repair.ts:100–121; experiment G |
| TOOL_NOT_STARTED identity | DSH repair layer | A | yes | yes | durable with its synthetic result (above) | YES once repair committed | n/a | n/a | ✗ ZERO EngineEvents — orphan-skip (no pending call; Correction A) | no | inherent | n/a | repair.ts:118–119; translator orphan path |
| surfaceOp/sourceEventSeqs metadata; compaction/prune events | DSH compaction protocol | A | yes | yes | appended live during compaction; conditional like any live append | CONDITIONAL | n/a | n/a | ✗ dropped (outside ReplayEvent) | no | inherent | n/a | pruner src; src :243–256 |

### B-class rows

| State/Fact | Owner/Src | Cls | LiveSess | Auth | Durability condition | InDurablePrefix | HistAlone | ExtraInput | RebuiltToday | WorldObs | PreserveVal | ResetConseq | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Session Surface projection | DSH foldSurface | B | derived | derived-as-projection | follows underlying records' durability | tracks raw log | HA=NO — needs full raw log + fold algorithm (DSH-owned) | foldSurface | Orcana never consumes surface (reads RAW superset) | no | n/a | n/a | surface.d.ts:80–95; src :396 |
| Root call/result pairing | Orcana translation | B | derived | no (derived view) | n/a (derived) | derived | PARTIAL — pairs derivable from history projection alone, but WHICH pairs exist depends on replay filter/domain | translation constants | YES for replay-visible pairs; NOT_STARTED results unpairable | no | n/a | n/a | src :274–305 |
| Verification receipts (status/gen/command/callId) | Orcana engine | B | derived | no | derived | derived | **HA=NO** | **current config**: fingerprintWindow, verifyCommandPatterns, inlineRepeatTools are CONSTRUCTOR inputs (:379–381, rebuild :398–402) | mechanically YES; value distorted: unknown→FAIL (G), replacement overwrite (D6), nested absent | CURRENT validity: YES world | AMBIGUOUS (inputs degraded) | stale receipt set until re-derived/re-observed | src :376–385, :398–405; experiments G/J |
| Workspace generation (given stream) | Orcana engine | B | derived | no | derived | derived | **HA=NO** | same constructor config (mutation set = MUTATION_TOOLS fixed, but stream domain differs) | mechanically YES; VALUE non-equivalent live↔rebuild (live-biased: nested/pre-decision hashes; replay-biased: final-results, replacement 2nd applications, synthetic results) | ACTUAL mutation truth: YES world | AMBIGUOUS | gen=0 erases mutation memory; freshness unfounded | Correction B wording; experiments A/H/J |
| Evidence freshness vs internal generation | Orcana pure fn | B | derived | no | derived | derived | HA=NO (needs generation+receipts, which need config) | as above | YES deterministic (p3.spec) | meaning: YES world | n/a | n/a | core isStale/render; p3.spec |
| Completion PURE violation set | Orcana guard fn | B | derived | no | derived | derived | **HA=NO** | **completion config**: claimCheck, claimPatterns, verifyPatterns (:521–527); inputs gen/receipts/text | recomputed deterministically; unknown lands as FAIL → rule-2 spurious fire (G) | truthfulness: YES world | n/a | different restart config ⇒ different violation set for SAME history | :519–527; completionViolations :697+ |
| Completion EFFECTIVE stop/continue outcome | Orcana guard × DSH driver | **B′ (runtime control outcome)** | derived | no | derived | derived | **HA=NO** | TurnState verdict → chain → decideSteer(config thresholds/maxForced/mode/enabled) → forcedCount → **completion.mode==='evidence-bound'** gate + **forcedCount ≥ maxForcedContinuations SKIP** (:517–518) → agent.steer → nextStep inbox → stop/continue (agent.ts:295–300) | violation EXISTENCE ≠ continuation: guard skipped entirely when mode off or budget exhausted | world truthfulness as above | see Reset-Safety | steer flips stop→continue whenever it fills nextStep | :503–527; agent.ts:295–300 |

### C-class rows

| State/Fact | Owner | Cls | HistAlone | ExtraInput | RebuiltToday | PreserveCorrectnessValue | ResetConseq | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fingerprint ring (window 8) | Orcana | C | **HA=NO** | fingerprintWindow, inlineRepeatTools (+fixed threshold 2, engine default, NOT config-exposed) | rebuilt with shifts (replacement double-count D6; hash drift) | **AMBIGUOUS / UNRESOLVED** — ring feeds repeated/significance classification → zeroProgress → chain → decideSteer → steer → stop/continue | detection-quality shift; control-flow influence possible via above chain | core :229, 267–285, :376–381; experiment B/J |
| Zero-progress chain | Orcana | C | **HA=NO** (needs round boundaries absent from replay domain + config thresholds) | zeroProgressThresholds, mode, enabled | ✗ resets to 0; first settle computed on polluted aggregate | **AMBIGUOUS / UNRESOLVED** — chain → threshold → decideSteer → agent.steer → nextStep → **stop/continue can change** | escalation timing shifts; turn continuation decisions can differ | core :367–382; :503–512; agent.ts:295–300 |
| Inline-repeat reminder state | Orcana (TurnState field) | C | **HA=NO** | inlineRepeatTools + fixed threshold | ✗ mis-derived: history-armed reminder fires on first live observation | **AMBIGUOUS / UNRESOLVED** (reminder is model-visible input into subsequent behavior) | mis-fire already observed (B) | experiment B |
| Forced-continuation budget | Orcana adapter WeakMap | C | **HA=NO** (raw material CONDITIONALLY durable — see below) | maxForcedContinuations, mode | ✗ deleted at resume (:403) | **AMBIGUOUS / UNRESOLVED**, though reset TENDS CONSERVATIVE: forcedCount→0 reopens steer budget → ladder/guard may call agent.steer again → next-step inserted → an immediate stop may be PREVENTED | oversight availability restored; possible extra continuations | :403, :506, :517–518, :532; agent.ts:126–128 |
| repeatedPattern | Orcana | C | **HA=NO** | as ring/chain | polluted (may name historical pattern) | AMBIGUOUS (steer-text content feeds model behavior) | strong-steer wording quality | experiment B |

### D-class rows

| State/Fact | Owner | Cls | RebuiltToday | PreserveVal | ResetConseq | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| TurnState (observations/mutation/significant/verifyNew/verifyPass/streak/fingerprint/reminder/fired) | Orcana engine | D | ✗ INCORRECTLY — single polluted aggregate instead of per-round states (runtime proof stands) | **AMBIGUOUS / UNRESOLVED** — TurnState → zeroProgress → chain → decideSteer → steer → stop/continue | clean per-round derivation would measure the true first round; CURRENT pollution distorts it | core :232,:312–355,:439–442; experiment B |
| engines WeakMap | adapter | D | swapped at resume | n/a | none | :370–372 |
| Router restriction install | config → DSH tools scope | D | **HA=NO** — resume decision depends on current mount-time `tools.disclosure`/`tools.defaultProfile` AND live registry composition (`resolveToolRestriction(profile, known)`, :441–455); re-applied at agent/created before session-start(resume) | n/a | none observed | :441–455 |
| Cordis listener registrations | Cordis | D | re-registered on mount | n/a | none | :333,:534–536 |

### New rows required by audit

| State/Fact | Owner/Src | Cls | Answers |
| --- | --- | --- | --- |
| **EngineSnapshot** `{generation,ring,receipts}` | Orcana engine (`snapshot()` :421–428) | B-shaped partial projection / serialization-test surface | Owner: ProgressFactEngine. Durable? **NO** (zero writers). Authoritative? **NO**. History-alone reconstructable? Its CONTENTS derive from config-fed folds (**HA=NO**). Requires config? yes (via constituents). World obs? no. Must preserve? **NO** — it is not a checkpoint authority. Reset consequence: none beyond constituents. Correctness significance: exists to prevent mistaking this surface for a ready-made checkpoint; `restore()` test-only | core :82–87,:421–437; dsh-governor :426,:529 |
| **Orcana configuration / runtime composition** | plugin Config schema (:94–133) + bundle patch row | CONFIGURATION feeding all derived-state derivations | Verified knobs relevant to recovery-relevant derived state: `governor.fingerprintWindow`(8), `governor.zeroProgressThresholds`([2,3,4]), `governor.inlineRepeatTools`(['read','bash','*search*']), `evidence.verifyCommandPatterns`([test,typecheck,build,check,lint]), `evidence.freshness`('generation'), `governor.mode`/`enabled`, `completion.mode`('evidence-bound'), `completion.maxForcedContinuations`(3), `completion.claimCheck`(false), `completion.claimPatterns`, `tools.disclosure`('task-profile'), `tools.defaultProfile`('coding'). Inline-repeat THRESHOLD is an engine constant (2), NOT config-exposed. Mount-time; survives restart only as config, and every config-sensitive derivation reads the CURRENT value at rebuild time ⇒ same history + different restart composition ⇒ different derived state | schema :94–133; constructor :376–385; rebuild :398–402; guard :519–527 |

## C. World-Drift Matrix

Preserved from Rev.0 (audit PASS) with one narrowing note. Historical
Session truth cannot prove present-tense world facts regardless of
durability:

| Drift subject | History CAN prove | History CANNOT prove | Must be freshly observed | Unsafe to assume | Completion impact |
| --- | --- | --- | --- | --- | --- |
| Filesystem contents | write/edit tools returned success at some seq; snapshots | current state; post-return modifications | current contents | successful write still holds | HIGH |
| git HEAD | historical success of commit/checkout | current HEAD | fresh rev-parse | workspace at historically-seen commit | HIGH |
| git index/worktree | status snapshots at most | current staged/untracked/dirty | fresh status | carried cleanliness | MED-HIGH |
| Running/background processes | ack text; timeout/signal markers (foreground) | finished? exit? effects? | liveness/exit query | acknowledged job succeeded | MED |
| External services/APIs | captured traces | service-side state; uncaptured calls | fresh queries | side-effect freedom without evidence | task-dependent |
| Post-TOOL_OUTCOME_UNKNOWN side effects | THAT outcome is unknown (durable synthetic record) | whether execution mutated anything | external inspection | BOTH "failed" AND "succeeded" | HIGH |
| Unknown-outcome mutation (write/edit crashed) | durable call; synthetic isError=true; Orcana sees NEITHER success NOR ambiguity (H) | whether workspace changed | workspace inspection | generation==0 ⇒ pristine | HIGH |
| Verification evidence after later mutation | pass receipt @old-gen; internal staleness flag | present validity | re-run/inspect | old PASS = current truth when internal generation failed to advance (A/E/H) | HIGH |
| Workspace changes while Orcana down | nothing | everything | full re-orientation | continuity of gen/receipts as world description | HIGH |
| Actual world freshness of ANY historical verification | historical result only | present validity | fresh observation | PASS-then ⇒ PASS-now | HIGH |

Narrowing note: "historical" facts themselves require the durability
qualifiers of section B — a result whose record did not survive the crash
window proves nothing post-resume.

## D. Reset-Safety Assessment (REVISED)

Correction applied everywhere: **Orcana steering is control flow.**
Verified chain (rc.6): `decideSteer`/guard → `agent.steer(msg)` =
`send(msg,'next-step',true)` (agent.ts:126–128) → message inserted into
nextStep inbox + driver woken → at stop boundary, `turnEnds &&
nextStep.length===0` gates emission AND the final break (:295–300); a steer
between the two checks flips STOP→CONTINUE. Therefore heuristic states that
feed steering have CONTROL-FLOW reach, and "efficiency-only" is NOT
proven for them.

| State | Current restart behavior | False-truth risk from reset | Control-flow reach via steer | Preservation correctness value | Verdict |
| --- | --- | --- | --- | --- | --- |
| TurnState | polluted aggregate (not clean reset); sticky flags judged in first settle; armed reminder fires on first live call | none found | YES — zeroProgress verdict → chain → decideSteer → steer → stop/continue | **AMBIGUOUS / UNRESOLVED** | behavior distortion CONFIRMED; preservation value open |
| Zero-progress chain | resets to 0; first verdict computed over polluted aggregate | none found | YES — threshold hit ⇒ steer ⇒ stop/continue can change | **AMBIGUOUS / UNRESOLVED** | "efficiency-only" WITHDRAWN; safe-but-lossy not proven |
| Ring / repeated-observation classification | rebuilt with shifts | none found | INDIRECT — classification feeds significance ⇒ zeroProgress ⇒ same chain | **AMBIGUOUS / UNRESOLVED** | remains class C; efficiency-only claim withdrawn |
| repeatedPattern | polluted | none found | YES (steer text content) | AMBIGUOUS | quality-only so far as observed |
| Forced-continuation budget | deleted (:403) — TENDS CONSERVATIVE: budget reopens → ladder/guard may steer again → next-step inserted → immediate stop may be prevented | none found | YES — directly | **AMBIGUOUS / UNRESOLVED** (with conservative-direction noted) | reset leans safer for oversight; not proven value-free |
| Router/process-local installs | re-applied from config | none | router restricts tools, does not steer | n/a | no issue |
| engines registry | swapped | none | n/a | n/a | no issue |

Accurate global boundary (replaces Rev.0's invalid proof claim):

> No false-completion counterexample has yet been proven. However, the
> previous reset-safety argument was INVALID because Orcana steering can
> alter DSH stop/continue control flow. For several heuristic/control states,
> preservation correctness value therefore remains AMBIGUOUS / UNRESOLVED.
> Additionally, NO existing test exercises
> pre-crash heuristic state → restart/reset → attempted completion →
> stop/continue comparison, so reset-safety remains unproven by tests.

## E. Projection-Loss Assessment

Preserved from Rev.0 (audit PASS_WITH_RISK); durability qualifiers added —
"exists in live Session" ≠ "survived THE particular crash":

| Fact | In live Session? | Survived the crash (durable prefix)? | Projection outcome | Category | Evidence |
| --- | --- | --- | --- | --- | --- |
| TOOL_NOT_STARTED synthetic result | yes (after repair) | yes once repair committed | DROPPED ENTIRELY (orphan-skip, 0 EngineEvents) | drop | Correction A; translator orphan path |
| TOOL_OUTCOME_UNKNOWN synthetic result | yes | yes once repair committed | WEAKENED — event folds; code/name lost; UNKNOWN→FAIL (G) | weaken | :243–256,296–300; experiment G |
| Surface replacement (+surfaceOp/sourceEventSeqs/prune) | yes | CONDITIONAL (appended live; needs later boundary) | DISTORTED — second full application; mutation replacements double generation (I/J) | distort | D5/D6/D7 |
| Code-dispatch nested records | yes | CONDITIONAL (nested ⇒ no independent checkpoint) | DROPPED from replay | drop | D1/D2 |
| final-result failures | yes | CONDITIONAL | INVERSE ASYMMETRY — replay-only (bypassed live) | inverse asymmetry | dsh-tools :301–303 |
| Nesting identity (rootCallId/subCallId/parent) | yes | tracks host record | DROPPED (callId-only EngineEvent) | drop | EngineEvent :44–79 |
| Root bash receipt identity/status (unreplaced, markered) | yes | CONDITIONAL (result-append window) | PRESERVED for surviving records | preserve | adapter.spec.ts:105–143 |
| Synthetic-unknown verification status | yes | yes once repair committed | WEAKENED (FAIL≠UNKNOWN) | weaken | experiment G |
| Replaced verification receipt | yes (two records) | CONDITIONAL | DISTORTED (last-copy overwrite) | distort | D6 |
| World-truth of any of the above | NEVER in Session | n/a | must remain unknown / require world observation | world requirement | World-Drift Matrix |

## F. Open Questions

KNOWN checkpoint semantics (no longer "unknown"): LLM-request flush-before-
dispatch; top-level tool call flush-before-body; pre-step flush of preceding
batch; nested dispatch reuse of outer durability — all rc.6-verified with
fail-closed behavior at model/tool boundaries.

UNRESOLVED exact crash-tail cases (deferred to R0-C; do not guess):

1. Post-result-append, pre-next-boundary windows (exact loss set for a crash
   between a `tool/result` append and the next flush).
2. Full enumeration of lifecycle boundary interactions beyond the three
   semantic checkpoints above.
3. Whether steered-but-unclaimed next-step messages can survive any path
   (currently: they are inbox-only until claimed — window confirmed, full
   timing analysis deferred).
4. Background eventual-result lifecycle.
5. Downstream post-execute replacement/block deployed frequency.
6. Accidental physical duplicate frequency.
7. Deployed DSH version vs lockfile rc.6 consistency.
8. Does preserving chain/budget/TurnState improve governance enough to
   matter? (no correctness evidence either way)
9. Do code-dispatch records suffice for faithful nested-verification
   receipts? (content present in type; fidelity unverified)

Execution environment note: Master Plan document not available locally
(existing external input; not a runtime ambiguity).

## Evidence Index (fresh this revision)

| Claim | Command/location | Result |
| --- | --- | --- |
| LLM/tool/pre-step/nested checkpoint semantics; fail-closed | rc.6 session-checkpoint-policy/src/index.ts (full 83-line read @15148dbd9a) | verified verbatim |
| steer = send('next-step',true)+wake | rc.6 agent-loop/src/agent.ts:120–132 | verified |
| stop path double-check + continue target | rc.6 agent-loop/src/agent.ts:295–301 | verified |
| steered message becomes durable user/message only at step claim | rc.6 agent-loop/src/agent.ts:281–284 | verified |
| engine constructor/rebuild consume config | dsh-governor src :376–385, :398–402 | verified |
| guard skip paths (mode; forcedCount≥max) + config options | dsh-governor src :516–527 | verified |
| config knob inventory + defaults | dsh-governor src :94–133 | verified |
| targeted suites | governor-core core+p2: 42 PASS; dsh-governor adapter: 11 PASS | exit 0 both |
| resume-path test coverage | grep 'session-start' across dsh-governor tests | 0 hits ⇒ reset-safety unproven by tests |
| G/H/I/J + A/B/D/E experiments | /tmp/r0a-rev3.mts, /tmp/r0a-experiment{,2}.mts | reproduced identically earlier this branch; seams unchanged since |

All seam citations carried from R0-A remain valid (seams unchanged);
checkpoint-policy and agent-loop citations are newly read THIS pass from
locked rc.6 sources, not taken from any audit report.

## Scope Statement

Docs-only revision. No production/DSH/Orcana implementation, tests, configs,
persistence, or other-phase artifacts modified. Checkpoint semantics were
READ to classify correctly — no checkpoint/persistence machinery is proposed
or added anywhere.
