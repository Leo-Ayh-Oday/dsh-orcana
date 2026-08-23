# R0-B — Reconstructability & World-Drift Matrix (Rev.3)

Classification of every recovery-relevant state/fact identified in R0-A
(accepted `215595e`). Answers: what is durable, what is derived, what is
resettable, what must be re-observed, what remains unknown. Not a correctness
contract, not R0-C crash-boundary analysis, not a recovery design.

Revision history: Rev.0 established the inventory; Rev.1 (`d363eb8`) added
durability qualifiers (checkpoint boundary), steer stop→continue semantics,
and honest reset-safety downgrades; Rev.2 (`627bb45`) corrected the dependency
graph and taxonomy — **all accepted and preserved here**; Rev.3 (this
revision) corrects the DURABLE/NATIVE FACT VOCABULARY and the
PRODUCER/CONSUMER TOPOLOGY per third-round audit:

- PHANTOM REMOVED: there is NO ordinary nested `tool/call` record in the
  rc.6 producer topology. Ordinary model-issued calls produce `tool/call` via
  `appendToolCall`; code-mode nested sub-dispatches produce
  `tool/code-dispatch-start` + `tool/code-dispatch` only. The checkpoint
  predicate (`exec.parent !== undefined`) governs CHECKPOINTS for nested
  EXECUTIONS and proves nothing about which event types exist.
- `request/header` RECLASSIFIED as recovery-relevant native fact: DSH
  AgentLoop request reconstruction consumes it via `session.requestHeader()`
  (`buildRequest`); first resumed request appends `{reason:'resume'}`.
  Orcana consumer: none.
- `session/end-seed` RECLASSIFIED as lifecycle/recovery-relevant native fact:
  compaction entry-state reconstruction consumes it
  (`inspectCompactionEntryState` → `assertCompactionInactive`). Orcana
  consumer: none.
- Consumer-completeness rule adopted: "no ORCANA consumer" ≠ "no recovery
  consumer" — dispositions now require a full DSH-runtime + Orcana check.
- Durability timing model corrected to write-behind semantics: after append,
  crash-surviving durability is CONDITIONAL until actually persisted or
  covered by a guaranteed barrier; write-behind MAY persist earlier; an
  explicit semantic `flush()` GUARANTEES the prior admitted prefix. The old
  "enters durable prefix at NEXT checkpoint" phrasing is withdrawn.

- one precise meaning of `HistoryAlone`; determinism / actual-reconstruction /
  semantic-completeness split into separate fields;
- dependency narrowing driven by source: receipts ← verifyPatterns only;
  ring ← fingerprintWindow only; chain-state inputs separated from steering-
  decision inputs;
- settlement boundary made explicit: `agent/turn-stopping` occurrence ≠
  durable `turn/end`;
- Session Surface and current replay-visible pairing → HistoryAlone = YES
  (fixed algorithm is not an extra input);
- Session header durability = persistence MATERIALIZATION conditional (not
  "crosses checkpoints like any record");
- taxonomy repaired: no undefined seventh `CONFIGURATION` class, no undefined
  `B′` class, no `B-shaped` label — composites are modeled as composite /
  cross-cutting without independent A–F classification;
- every R0-A fact classified or explicitly dispositioned.

## Baseline

- Branch `research/durable-recovery-r0-b`; starting HEAD
  `d363eb83422eafa56b3c731a6b0ae8277594694f` (audited Rev.1); worktree clean;
  accepted R0-A base `215595e` ancestor.
- Source seams unchanged since audited state (`git diff --stat 215595e --
  packages/ benchmark/` empty). Lockfile basis rc.6.
- Fresh source checks THIS pass (not taken from audit reports): receipt
  transition reads `this.patterns` only (core :287–289); ring transitions read
  `this.window` only (:275–285); inlineTools/inlineThreshold are observeTurn
  inputs (:237–238, threshold default 2, not adapter-config-exposed); rc.6
  jsonl persistence defers header write until first batch (`appendBatch` →
  `materialize` writes "header line + first batch", temp-write/fsync/publish;
  `list()` reads only materialized artifacts).
- NEW producer/consumer evidence THIS pass (Rev.3): ordinary `tool/call`
  produced ONLY by `appendToolCall` from MODEL blocks (agent-loop
  tool-calls.ts:262–265); code-mode bridge emits `tool/code-dispatch-start`
  {rootCallId,parentCallId,subCallId,name,arguments} at pipeline entry and
  `tool/code-dispatch` (+isError,content) on settle (code-mode.ts:535–541,
  :510–521) — no ordinary nested call exists; `session.requestHeader()` folds
  request/header events and AgentLoop `buildRequest` consumes it for route-
  relative config/explicit-effort restoration, appending `{reason:'resume'}`
  on first resumed request (agent.ts:413–467); compaction entry-state scan
  reads latestEndSeedSeq (region.ts:517–552) feeding
  `assertCompactionInactive` (:286–300); persistence uses bounded WRITE-BEHIND
  batching (SessionWriteBehind, default max delay 200ms) with `flush()` as an
  explicit quiescence/durability BARRIER (coordinator.ts:29–30, write-behind.ts
  :22–72).
- Fresh tests this pass: governor-core core+p2 42 PASS; dsh-governor
  adapter.spec 11 PASS (exit 0). Resume-path behavioral coverage remains ZERO
  (grep 'session-start' in dsh-governor tests = 0) ⇒ reset preservation
  correctness stays unproven-by-tests.

## A. Classification Legend (Rev.2)

Six classes (unchanged set):

- **A. authoritative native durable fact** — owner DSH Session/native
  runtime; available to recovery when it belongs to the crash-surviving
  durable prefix under applicable persistence/checkpoint semantics (Rev.1
  equation preserved; Session HEADER uses a distinct METADATA-MATERIALIZATION
  rule — see row).
- **B. deterministic derived state** — output fully determined by its stated
  inputs + a fixed algorithm.
- **C. derived optional / heuristic state** — lossy/heuristic behavior-quality
  mechanisms; preservation-correctness value assessed separately.
- **D. ephemeral turn / process state** — process-local containers or
  round-scoped accumulators.
- **E. external world state requiring observation.**
- **F. ambiguous / unresolved.**

### `HistoryAlone` — single precise definition (Rev.2)

> **HistoryAlone = YES** means: given the crash-surviving authoritative
> history that actually reloads, plus the FIXED current implementation
> algorithm/version, the derived value is determined — with NO restart-
> variable config, NO ephemeral/process-local runtime state, NO lifecycle
> occurrence absent from durable history, and NO current world observation.
>
> The fixed fold/translation algorithm itself is NOT an ExtraInput.
> `history + fixed fold algorithm` ⇒ HistoryAlone = YES.
>
> **HistoryAlone = NO** iff rebuild additionally requires any of: current
> variable config; runtime composition; ephemeral process-local state;
> lifecycle occurrences not represented in durable history; current world
> observation.

Three previously-conflated concepts are now SEPARATE fields and must never be
merged again:

1. **Deterministic from history?** (HistoryAlone axis)
2. **Does current Orcana actually reconstruct it?** (algorithm runs on the
   feed it has)
3. **Is that reconstruction semantically complete/correct?** (projection
   completeness vs the fuller live/domain truth)

Cross-cutting statuses (NOT new classes): **composite projection** (inherits
constituent classifications), **cross-cutting reconstruction input**
(configuration), **composite runtime control outcome** (control-flow result of
multiple states/config/lifecycle). These carry no independent A–F membership.

Standing distinctions enforced everywhere: *fact exists durably* ≠ *Orcana
reconstructs it correctly*; *runtime-derived truth* ≠ *actual world truth*;
*event ∈ live session.events* ≠ *event ∈ persisted/reloadable prefix*.

### Durability TIMING model (Rev.3)

After `session.append`, crash-surviving durability is **CONDITIONAL** until
the record is actually persisted or covered by a guaranteed barrier:

- **Write-behind MAY persist earlier**: admitted events drain through a
  bounded batching window independent of any semantic checkpoint
  (`SessionWriteBehind`, default max intentional delay 200ms —
  coordinator.ts:29–33).
- **An explicit semantic `flush()` GUARANTEES** that all previously ADMITTED
  events have been drained/persisted per the persistence contract
  (write-behind.ts:58–72 — "cancel the batching wait and durably drain
  through a quiescent point"; concurrent callers join the same barrier).

Therefore neither "only becomes durable at the next checkpoint" nor
"immediately durable on append" is correct. Exact micro-boundary enumeration
remains R0-C scope.

### Consumer-completeness rule (Rev.3)

A disposition of "not independently recovery-relevant" requires checking ALL
potential consumers — Orcana governor, DSH AgentLoop, DSH persistence, DSH
compaction/lifecycle, Session resume/replay/surface paths. **No Orcana
consumer ≠ no recovery consumer**, because DSH itself is the sole execution
runtime whose own reconstruction needs make facts recovery-relevant.

## B. Reconstructability Matrix

### A0. KNOWN Checkpoint Semantics (rc.6, source-verified)

From `session-checkpoint-policy/src/index.ts` (rc.6 @15148dbd9a, full file):

| Boundary | Verified behavior |
| --- | --- |
| LLM request | `llm/stream` wrapper: flush completes BEFORE the downstream adapter stream yields its first chunk — the complete logged request prefix is durable; fail-closed (checkpoint rejection prevents adapter dispatch) |
| Top-level tool | `tools/execute` listener (ONLY when `exec.agent !== undefined && exec.parent === undefined`): flush AFTER the recorded call, BEFORE the body runs; fail-closed (aborted-before-dispatch result) |
| agent/pre-step | flush BEFORE each next step — persists everything committed by the preceding step |
| Nested dispatch | `exec.parent !== undefined` → NO independent checkpoint; nested dispatches reuse the durable outer call |

Direct consequences: if a top-level tool body has truly begun, its top-level
call HAS crossed its explicit barrier; a just-appended result has NOT
necessarily crossed anything yet (write-behind may persist it earlier);
nested records ride outer-call durability plus later barriers.

Scope caveat (Rev.3): this policy governs CHECKPOINTS FOR EXECUTIONS. It says
NOTHING about which Session event types exist — the nested durable vocabulary
is `tool/code-dispatch-start`/`tool/code-dispatch` (producer-verified below);
no ordinary nested `tool/call` exists in the rc.6 producer topology.

Columns per row: Taxonomy · Owner/Auth · LiveSess · Durability/Materialization
qualifier · HistoryAlone · VariableExtraInput · LifecycleDep · WorldObs ·
DetRebuilt (current algorithm deterministically rebuilds it?) · SemComplete
(today's rebuilt value semantically complete?) · PreserveVal · ResetConseq ·
ProjectionLoss · Evidence.

### A-class rows

| State/Fact | Taxonomy | Owner/Auth | LiveSess | Durability qualifier | HistAlone | VarExtraInput | LifecycleDep | WorldObs | DetRebuilt | SemComplete | PreserveVal | ResetConseq | ProjLoss | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Session header / identity | A — authoritative METADATA (distinct from events) | DSH SessionHeader | held in live session | **MATERIALIZATION-conditional**: create may defer physical write until FIRST append; jsonl `appendBatch`→`materialize` atomically writes header line + first batch (temp/fsync/publish); zero-append session may be absent from persistence `list()` | n/a (metadata, not derived) | none | none | no | n/a | n/a | inherent once materialized | n/a | none | jsonl index.ts:421–427,514–528; list :447–477 |
| user/task messages | A | DSH user/message | yes | appended when driver claims into step; crash-surviving durability CONDITIONAL until persisted (write-behind may persist earlier) or covered by a guaranteed barrier (next pre-step/request/top-level-call flush) | CONDITIONAL (barrier/write-behind) | n/a | step-claim lifecycle | no | n/a | n/a | inherent post-barrier | n/a | none | agent.ts:283; policy :35,:70–76,:79–82; write-behind.ts |
| assistant/message (+tool requests) | A | DSH | yes | same conditional pattern | CONDITIONAL | n/a | step lifecycle | no | n/a | requests unconsumed by engine; provenance for TOOL_NOT_STARTED repair | no | inherent | n/a | repair.ts:44–48 |
| tool/call — ORDINARY (model-issued) | A | DSH — producer `appendToolCall`, MODEL tool-call blocks only (agent-loop tool-calls.ts:262–265) | yes | recorded → flushed BEFORE body (fail-closed); body-start ⇒ call crossed its explicit barrier; write-behind may persist earlier | YES-once-body-started; otherwise CONDITIONAL (write-behind/barrier) | n/a | dispatch lifecycle | no | n/a | n/a | inherent post-barrier | n/a | none | tool-calls.ts:262–265; policy :70–76 |
| tool/code-dispatch-start | A | DSH code-mode bridge (code-mode.ts:535–541) | yes | nested ⇒ no independent semantic checkpoint; write-behind may persist earlier; later barriers cover | CONDITIONAL (barrier/write-behind) | n/a | run_code transport lifetime | no | ✗ dropped by Orcana replay filter | fields rich: rootCallId,parentCallId,subCallId,name,arguments(byte-identical sibling JSON) | inherent | n/a | drop-from-replay | code-mode.ts:535–541; src :258–268 |
| tool/code-dispatch (settlement) | A | DSH code-mode bridge (code-mode.ts:510–521) | yes | same conditional pattern | CONDITIONAL (barrier/write-behind) | n/a | run_code transport lifetime | no | ✗ dropped by Orcana replay filter | adds isError + complete model-facing content over start-fields; queued-and-abandoned calls log neither event | inherent | n/a | drop-from-replay (code-mode nested effects gap stands — via THESE records, not any nested tool/call) | code-mode.ts:504–521; tools README:123 |
| tool/result (original) | A | DSH | yes | appended post-execution; NO dedicated result checkpoint; crash-surviving durability conditional until persisted/barrier-covered (write-behind may persist earlier) | CONDITIONAL (immediate-crash window) | n/a | execution completion | no | n/a | PARTIAL (isError silent-default; hash reflects durable bytes) | inherent | n/a | D3 caveat | types 299–310; dsh-tools :3359–3388 |
| Synthetic closer — TOOL_OUTCOME_UNKNOWN | A | DSH repair/persistence | yes | durable AT CREATION via commitRepair | YES-once-repair-committed | n/a | created during cold resume itself | no | n/a | WEAKENED through Orcana (identity lost; UNKNOWN→FAIL — G) | inherent | n/a | weaken | repair.ts:100–121; coordinator :892–957 |
| Synthetic closer — TOOL_NOT_STARTED | A | DSH repair layer | yes | durable AT CREATION | YES-once-repair-committed | n/a | as above | no | n/a | ✗ ZERO EngineEvents — orphan-skip (no pending call) | inherent | n/a | drop | repair.ts:118–119; translator orphan path |
| tool/code-dispatch records | A | DSH bridge | yes | nested ⇒ no independent checkpoint; later batch flushes cover | CONDITIONAL | n/a | run_code transport lifetime | no | n/a | ✗ dropped by replay filter (facts rich: name/isError/content/subCallId) | inherent | n/a | drop | CodeDispatchLog :239–252 |
| surfaceOp/sourceEventSeqs metadata; compaction/prune events | A | DSH compaction protocol | yes | conditional until persisted/barrier-covered (write-behind may persist earlier) | CONDITIONAL | n/a | compaction pass | no | n/a | ✗ outside ReplayEvent | inherent | n/a | drop→distort (D6/D7) | pruner src |
| request/header | A — native REQUEST-RECONSTRUCTION input | DSH request lifecycle (AgentLoop buildRequest append) | yes | conditional like any live event record | CONDITIONAL (barrier/write-behind) | n/a | request boundaries | no | ✗ no Orcana consumer | consumed BY DSH: `session.requestHeader()` fold → AgentLoop buildRequest restores route-relative config continuation + explicit-vs-adapter-default reasoningEffort (:413–431); first resumed request APPENDS `{reason:'resume'}` (:459–461) | inherent post-barrier | n/a | unconsumed-by-Orcana only | agent.ts:413–467; session index.ts:657–680 |
| session/end-seed | A — lifecycle/compaction-reconstruction input | DSH Session constructor (sole legitimate writer per SessionEventMap) | yes | conditional like any live event record | CONDITIONAL (barrier/write-behind) | n/a | seed/lifecycle close | no | ✗ no Orcana consumer | consumed BY DSH compaction: `inspectCompactionEntryState` scans latest end-seed seq (region.ts:517–552) → `assertCompactionInactive` classifies a durable unmatched `compaction/start` as current-lifecycle vs ended-lifecycle (:286–300) | inherent post-barrier | n/a | unconsumed-by-Orcana only | region.ts:286–300,517–552; SessionEventMap end-seed docs |
| turn/end — NORMAL | A | DSH | yes | conditional like any event | CONDITIONAL | n/a | driver loop close | no | n/a | consumed by NOBODY in Orcana replay filter; **≠ agent/turn-stopping settlement** (see Lifecycle note) | inherent | n/a | unconsumed | types :237–253; src :258–268 |
| step/end — NORMAL | A | DSH | yes | conditional like any event | CONDITIONAL | n/a | step close | no | n/a | filtered out of Orcana replay feed | inherent | n/a | unconsumed | types; src :258–268 |

### B-class rows

| State/Fact | Taxonomy | Owner | LiveSess | Durability qualifier | HistAlone | VarExtraInput | LifecycleDep | WorldObs | DetRebuilt | SemComplete | PreserveVal | ResetConseq | ProjLoss | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Workspace generation | B | Orcana engine (derived) | derived | derived | **YES** — deterministic fold of `event.mutation` over the surviving stream; fixed algorithm is not an input | **none** | none | ACTUAL mutation truth: YES | YES (over current replay-visible stream) | **NO/PARTIAL** — replay domain drops code-dispatch mutations, double-applies replacements (J), excludes unknown-outcome mutations (H) | AMBIGUOUS (inputs degraded) | gen=0 erases mutation memory | D1/D2/D6/H | core :267–286 (`generation += 1` on mutation); experiments |
| Verification receipts | B | Orcana engine | derived | derived | **NO** | **verifyPatterns ONLY** — receipt creation gated by `isVerificationCommand(tool,command,this.patterns)` (:287–289); status from interrupted/exitCode/isError (:292–301). fingerprintWindow / inlineRepeatTools do NOT feed receipt creation | none | CURRENT validity: YES | YES mechanically | NO/PARTIAL — unknown lands FAIL (G); replacement overwrite (D6); nested verifications absent | AMBIGUOUS | stale set until re-derived/observed | G/D6 | core :287–303; receiptStatus |
| Evidence freshness vs internal generation | B | Orcana pure fn | derived | derived | **NO** | needs generation+receipts (receipts need verifyPatterns) | none | meaning: YES world | YES | internal-fresh ≠ world-fresh | n/a | n/a | inherited | isStale/renderVerificationState |
| Completion PURE violation set | B | Orcana guard fn | derived | derived | **NO** | claimCheck, claimPatterns, verifyPatterns (:521–527); inputs generation/receipts/lastAssistantText | none | truthfulness: YES world | YES over its inputs | degraded inputs propagate (G/H/D6) | n/a | different restart composition ⇒ different violation set for same history | inherited | :519–527; completionViolations :697+ |
| Root call/result pairing — CURRENT REPLAY-VISIBLE pairing | B (derived view) | Orcana translation | derived | derived | **YES** — surviving history + fixed sessionReplayEvents/translateSessionEvents deterministically yields today's pairing | none | orphan-skip behavior is part of the FIXED algorithm | no | YES (deterministic over feed) | **NO/PARTIAL** — NOT_STARTED results unpairable; duplicates/replacements both pair; nesting identity lost | n/a | n/a | Correction-A drop; D6/D7; D8 | src :243–305 |
| Session Surface projection | B (DSH-derived view) | DSH foldSurface | derived | tracks raw records' durability | **YES** — surviving raw history + fixed DSH fold algorithm ⇒ surface | none | replacement shadowing is part of fixed fold | no | YES (DSH-side) | surface-faithful by construction; Orcana does not consume it (raw superset instead) | n/a | n/a | Orcana consumes RAW (superset incl. shadowed) | surface.d.ts:80–95 |

### C-class rows

| State/Fact | Taxonomy | Owner | HistAlone | VarExtraInput | LifecycleDep | DetRebuilt | SemComplete | PreserveVal | ResetConseq | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| Fingerprint ring | C heuristic | engine | **NO** | **fingerprintWindow ONLY** — push/shift/prune read `this.window` (:275–285); mutation prune reads generation | round scope; window eviction is intentional loss | YES over feed | NO — window eviction discards older fingerprints; replacement double-entries shift contents (D6/J) | **AMBIGUOUS / UNRESOLVED** — classification feeds significance → zeroProgress → steer → stop/continue | detection-quality shift | core :229,275–285; experiment J |
| Zero-progress CHAIN STATE (counter value) | C heuristic | engine | **NO** | NONE directly — but its INPUTS are: per-round observations + repeated/significance classification (ring/window + verifyPatterns) + verifyNew/verifyPass + **Orcana settlement boundaries (agent/turn-stopping occurrences)** which are lifecycle facts ABSENT from durable history | settlement occurrences per DSH turn (0..n) | ✗ resets to 0; first settle computed over polluted aggregate | NO — true chain requires settlement-boundary history that replay does not contain | **AMBIGUOUS / UNRESOLVED** | escalation timing shifts | core :367–382; endTurn zeroProgress = !mutation&&!significant&&!verifyNew&&!verifyPass |
| Steering DECISION (decideSteer outcome) | C heuristic decision — DISTINCT from chain value | adapter | **NO** | zeroProgressThresholds, enabled, mode, maxForcedContinuations (+chain verdict + forcedCount) | turn-stopping occurrence | recomputed live each stop | n/a | **AMBIGUOUS / UNRESOLVED** | steer ⇒ nextStep ⇒ stop/continue can flip | :503–512; decideSteer |
| Inline-repeat reminder state | C heuristic | engine (TurnState field) | **NO** | inlineRepeatTools + fixed threshold 2 | round scope | ✗ mis-derived (armed-from-history fires on first live observation) | NO | **AMBIGUOUS / UNRESOLVED** | mis-fire observed (B) | :332–354; experiment B |
| repeatedPattern | C heuristic | engine | **NO** | as ring/chain | round scope | polluted | NO | AMBIGUOUS | steer-text quality | :333–337 |
| Forced-continuation budget | C heuristic counter | adapter WeakMap | **NO** | maxForcedContinuations (comparison), mode | inbox/step-claim lifecycle gates whether steered messages become durable | ✗ deleted at resume (:403); TENDS CONSERVATIVE (budget reopens → steer possible → immediate stop may be prevented) | n/a | **AMBIGUOUS / UNRESOLVED** | oversight availability restored; extra continuations possible | :370–372,:403,:506,:517–518,:532; agent.ts:126–128 |

### D-class rows

| State/Fact | Taxonomy | Owner | RebuiltToday | PreserveVal | ResetConseq | Evidence |
|---|---|---|---|---|---|---|
| TurnState (all ten fields) | D ephemeral round accumulator | engine | ✗ INCORRECTLY — single polluted aggregate across whole rebuilt history (runtime proof stands) | **AMBIGUOUS / UNRESOLVED** (feeds chain→steer→stop/continue) | clean per-round derivation would measure true first round; pollution distorts it | core :232,:312–355,:439–442; experiment B |
| engines WeakMap | D container | adapter | swapped wholesale | n/a | none | :370–372 |
| Router restriction install | D ephemeral scope install | config → DSH tools scope | YES re-applied at agent/created (**HA=NO** — depends on current tools.disclosure/defaultProfile + registry composition) | n/a | none observed | :441–455 |
| Cordis listener registrations | D | Cordis | re-registered on mount | n/a | none | :333,:534–536 |

### Composite / cross-cutting rows (NO independent A–F class)

| Row | Taxonomy status | Composition | Key facts |
|---|---|---|---|
| Effective STOP/CONTINUE outcome | **Composite runtime control outcome** — derived from A/B/C/D/config/lifecycle inputs; does NOT receive an independent classification (Rev.1's `B′` label retired) | TurnState verdict → chain → decideSteer(config thresholds/mode/enabled/maxForced) → forcedCount → completion.mode gate + forcedCount≥maxForcedContinuations SKIP (:517–518) → completionViolations → agent.steer → nextStep inbox → loop break check (agent.ts:295–300) | violation EXISTENCE ≠ continuation; steer fills nextStep ⇒ STOP→CONTINUE; HA=NO (ephemeral + config + lifecycle inputs) |
| EngineSnapshot `{generation,ring,receipts}` | **Composite projection** — inherits constituents' semantics (generation=B/deterministic; receipts=B/config-sensitive; ring=C/heuristic); acquires NO independent recovery class | snapshot() :421–428 | Durable=NO (zero writers); Authoritative=NO; restore() test-only; not a checkpoint candidate; HA=NO (via config-sensitive constituents) |
| Orcana configuration / runtime composition | **Cross-cutting reconstruction INPUT** — not an A–F recovery state | Config schema :94–133 + bundle patch | Verified knobs: governor.{enabled,mode,zeroProgressThresholds[2,3,4],fingerprintWindow 8,inlineRepeatTools['read','bash','*search*']}; evidence.{enabled,freshness'generation',**verifyCommandPatterns[test,typecheck,build,check,lint] ← SOLE OWNER of verify-pattern policy**}; completion.{mode'evidence-bound',maxForcedContinuations 3,claimCheck false,claimPatterns} — NOTE: NO verifyPatterns field exists under completion; completion logic merely CONSUMES evidence.verifyCommandPatterns (owner≠consumer, adapter :535); tools.{disclosure'task-profile',defaultProfile'coding'}; engine constant inlineRepeatThreshold=2 (not exposed). Mount-time; survives restart AS CONFIG; every config-sensitive derivation reads the CURRENT value ⇒ same history + different composition ⇒ different derived values. Per-field dependencies proven above (receipts←verifyPatterns; ring←fingerprintWindow; chain-steer←thresholds/mode/enabled/maxForced; violations←claim*/verify*(consumed); router←disclosure/defaultProfile) — "engine receives config" ≠ "each field depends on all config" |

### E-class rows (world; unchanged)

Filesystem contents; git HEAD/index/worktree; running/background processes;
external services/APIs; post-TOOL_OUTCOME_UNKNOWN side effects; unknown-outcome
mutation effects; workspace changes while Orcana down; actual present validity
of historical verification — ALL require fresh observation; history proves at
most past interaction traces (World-Drift Matrix below).

### F-class rows (unresolved; carried)

Accidental-duplicate frequency; checkpoint tail-loss exact bounds (see Known/
Unresolved split below); background eventual-result lifecycle; downstream
post-execute replace/block frequency; deployed-version consistency; governance
value of preserving chain/budget/TurnState; code-dispatch sufficiency for
faithful nested-verification receipts.

### R0-A fact disposition (completeness; Rev.3 consumer-completeness rule applied)

Rule applied: a "not recovery-relevant" disposition requires NO consumer
across the ENTIRE DSH runtime + Orcana. `no Orcana consumer ≠ no recovery
consumer`.

| Fact | Disposition |
|---|---|
| turn/end NORMAL | Classified (A-class row) — explicitly ≠ settlement |
| step/end NORMAL | Classified (A-class row) |
| turn/end {interrupted} reason | A-class durable marker; unconsumed by Orcana; DSH-side consumers not observed in audited sources |
| Request headers (`request/header`) | **RECLASSIFIED (Rev.3)** — recovery-relevant native fact; classified as A-class row above. DSH AgentLoop resume consumes it for request reconstruction; Orcana consumer none. Rev.2's "log-only routing metadata" disposition was FALSE (it rested on the invalid no-Orcana-consumer inference) |
| session/end-seed | **RECLASSIFIED (Rev.3)** — lifecycle/compaction-recovery-relevant native fact; classified as A-class row above. DSH compaction entry-state reconstruction consumes it; Orcana consumer none. Rev.2's "marker with no consumer" disposition was FALSE |
| todo/write events | Whole-list snapshot, latest-wins-on-replay per SessionEventMap; Orcana consumer none. DSH-core recovery consumer not observed in audited sources; UI-layer consumers may exist OUTSIDE audited scope — disposition narrowed accordingly (previously overstated as unconditional) |
| llm/retry*, text-chunks, tool-call-chunks, assistant/chunk | Stream/telemetry records WITH known DSH-side telemetry/timing consumers (e.g., assistant/chunk feeds first-token/sessionStats projections per dsh-llm docs); NO durable-state reconstruction role found in audited sources; Orcana consumer none |
| subagent/workflow descriptors | Harness-level composition records; outside Orcana engine inputs; DSH-side lifecycle consumers out of audited scope |

## C. World-Drift Matrix (preserved; audit PASS)

Unchanged conclusions, restated compactly: filesystem contents, git HEAD,
git index/worktree status, running/background processes, external services/
APIs, post-TOOL_OUTCOME_UNKNOWN side effects, unknown-outcome mutation
effects, workspace changes during downtime, and present-tense validity of any
historical PASS are WORLD facts: history proves at most past traces; current
values require fresh observation; assuming continuity is unsafe; completion
correctness impact HIGH unless freshly observed. Generation-relative freshness
≠ world freshness (Rule 3). Narrowing note retained: "historical" facts
themselves require the durability qualifiers above.

## D. Reset-Safety Assessment (preserved from Rev.1; audit accepted direction)

Standing verified chain: decideSteer/guard → `agent.steer` =
`send('next-step',true)`+wake (agent.ts:126–128) → stop gate
`turnEnds && nextStep.length===0` checked twice (:295–300) ⇒ steer flips
STOP→CONTINUE. Therefore:

- TurnState / zero-progress chain / ring / repeatedPattern / forced budget:
  preservation correctness value = **AMBIGUOUS / UNRESOLVED** (control-flow
  reach exists; no correctness proof either way; no test drives
  pre-crash-state → restart → stop/continue comparison).
- Forced-budget reset TENDS CONSERVATIVE (restores guard/steer availability)
  — directional note only, not a proof.
- Global boundary statement (unchanged): no false-completion counterexample
  proven YET; previous safety argument invalid; reset-safety unproven.

## E. Projection-Loss Assessment (preserved; audit PASS_WITH_RISK; durability qualifiers kept)

TOOL_NOT_STARTED synthetic result → DROP (orphan-skip, 0 EngineEvents);
TOOL_OUTCOME_UNKNOWN → WEAKEN (identity lost, UNKNOWN→FAIL — G); surface
replacement → DISTORT (second application; I/J); code-dispatch → replay DROP;
final-result failures → INVERSE asymmetry (replay-only); nesting identity →
DROP; root-bash receipts (surviving, unreplaced, markered) → PRESERVED;
replaced receipts → DISTORTED (last-copy overwrite); synthetic-unknown status →
WEAKENED. Qualifier everywhere: *exists in live Session* ≠ *survived THE
crash* — prefix membership follows the durability conditions of section B.

## F. Open Questions

KNOWN checkpoint semantics (rc.6-verified, no longer open): LLM-request
flush-before-dispatch; top-level tool call flush-before-body; pre-step flush
of preceding batch; nested reuse of outer durability; fail-closed at model/tool
boundaries; header materialization at first append batch.

UNRESOLVED (deferred; unchanged in substance from Rev.1): post-result-append
pre-boundary loss windows; full lifecycle-boundary enumeration beyond the
three checkpoints; survivability of steered-but-unclaimed inbox messages
(window confirmed, timing deferred); background eventual-result lifecycle;
downstream replace/block deployed frequency; accidental duplicate frequency;
deployed-version consistency; governance value of preserving
chain/budget/TurnState; code-dispatch fidelity for nested-verification
receipts; whether settlement boundaries should ever become reconstructable
(fact-analysis question for R0-C — no design proposed here).

Execution environment note: Master Plan document not available locally
(existing external input; not a runtime ambiguity).

## Evidence Index (fresh this revision)

| Claim | Location | Result |
|---|---|---|
| Ordinary tool/call producer = appendToolCall (model blocks only) | rc.6 agent-loop tool-calls.ts:262–265 | verified in source |
| Nested durable vocabulary = code-dispatch-start/-dispatch; NO ordinary nested tool/call exists | rc.6 tools/src/code-mode.ts:535–541 (-start), :504–521 (-dispatch incl. rootCallId/parentCallId/subCallId/name/arguments/isError/content); tools README:123 | producer-verified; phantom row removed |
| request/header consumed by AgentLoop resume reconstruction; {reason:'resume'} appended on first resumed request | rc.6 agent-loop agent.ts:413–467 (`session.requestHeader()` fold; route-relative config/explicit-effort vs adapter-defaults) | consumer-verified |
| session/end-seed consumed by compaction entry-state reconstruction | rc.6 compaction-basic region.ts:286–300,517–552 (inspectCompactionEntryState → assertCompactionInactive latestEndSeedSeq comparison) | consumer-verified |
| Write-behind batching + flush() barrier semantics | rc.6 coordinator.ts:29–33 (200ms default window); write-behind.ts:22–72 (SessionWriteBehind; flush = quiescence barrier) | verified in source |
| Orcana zero consumers of request/header, requestHeader(), end-seed | grep across packages/{governor-core,dsh-governor}/src | 0 hits |
| verify-pattern policy owner = evidence.verifyCommandPatterns (completion namespace has none; completion logic consumes it at adapter :535) | dsh-governor src :103,:130,:535 vs completion block :105–112 | verified |
| Receipt creation gated by `this.patterns` only | core :287–289 | verified in source |
| Ring push/shift/prune use `this.window` only | core :275–285 | verified in source |
| inlineTools/threshold are observeTurn inputs; threshold constant 2 not config-exposed | core :226–238; dsh-governor schema :94–133 | verified |
| endTurn zeroProgress formula; chain ± | core :367–382 | verified |
| decideSteer inputs | adapter :495–512 + decideSteer definition | verified |
| guard skip paths + completion config options | adapter :516–527 | verified |
| steer/send/inject semantics; stop-path double check | rc.6 agent-loop agent.ts :120–132, :295–301 | verified |
| inbox message becomes durable user/message at step claim | rc.6 agent-loop agent.ts :281–284 | verified |
| header deferred materialization; atomic header+first-batch; list() reads materialized only | rc.6 jsonl index.ts :421–427, :511–528, :447–477 | verified |
| targeted suites | governor-core core+p2: 42 PASS; dsh-governor adapter: 11 PASS (exit 0) | fresh this pass |
| resume-path coverage gap | grep 'session-start' dsh-governor tests | 0 hits |
| G/H/I/J + A/B/D/E runtime experiments | /tmp/r0a-rev3.mts, /tmp/r0a-experiment{,2}.mts | reproduced earlier on this branch; seams unchanged since |

## Scope Statement

Docs-only. No production/DSH/Orcana implementation, tests, configs,
persistence, or other-phase artifacts modified. Settlement-boundary handling,
dedupe, and any durability machinery remain untouched facts/gaps — analysis
of them belongs to later phases.
