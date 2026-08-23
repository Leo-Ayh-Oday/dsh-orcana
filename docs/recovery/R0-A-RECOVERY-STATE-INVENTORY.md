# R0-A Recovery State Inventory (Rev.3)

Factual audit only: what exists, what reads it, what writes it, what cold
resume currently does, what rebuild currently does, what each layer currently
misses, what remains unknown. Not a correctness contract, not an R0-B
classification, not an R1 design.

Revision history: Rev.1 (`b10f694`) established the inventory; Rev.2
(`18bc39e`) corrected state-container framing, proved TurnState rebuild
pollution, and introduced three-level live/replay analysis; Rev.3 (this
revision) adds the previously missing DSH **cold crash-repair layer** and
**Session raw-log vs surface semantics**, and corrects every recovery claim
that depended on them. Rev.2 conclusions that survive re-verification are
kept unchanged.

## Baseline

- Branch: `research/durable-recovery-r0-a`
- Starting HEAD for this revision: `18bc39efbf6de8dfd6df11218f69b56ccc0c892a`
- Only file changed across all revisions:
  `docs/recovery/R0-A-RECOVERY-STATE-INVENTORY.md`
- Lockfile pins all audited DSH packages to **0.1.0-rc.6**; every DSH semantic
  cited below was verified against rc.6 artifacts installed in this workspace
  and/or the harness monorepo's rc.6 release commit
  (`deepseek-harness@15148dbd9a`, read via `git show` where the checkout has
  moved on). Master was NOT used as a substitute.
- Execution environment note: the project Master Plan document
  (`ORCANA-DURABLE-EXECUTION-EVIDENCE-RECOVERY-MASTER-PLAN-v0.1.md`) is not
  present on this machine (checked `/DSH/Architecture`, `$HOME`, worktrees).
  It is an existing external input to the program, not a runtime ambiguity,
  so it is recorded here rather than under Unknowns; its taxonomy/decision-rule
  cross-references could not be re-read this pass. The governing principles
  quoted in the task directives were applied as stated.
- Method note: behavioral claims are backed by locked-version source reading
  plus runtime experiments against the real engine/translator sources
  (`node --experimental-strip-types`; scripts and outputs indexed at the end).

## Current Architecture Map

Two Orcana packages, one dependency direction:

```
governor-core/src/index.ts (pure; imports only node:crypto)
  ProgressFactEngine          — per-agent mutable fact state
    applyEvent / observeTurn / endTurn / beginTurn(uncalled) / resetChains
    snapshot / restore(uncalled in prod) / static rebuild
        ↑ EngineEvent — unified input of the TOOL-OBSERVATION path ONLY
dsh-governor/src/index.ts (Cordis plugin)
  engines: WeakMap<Agent, ProgressFactEngine>   ← adapter-local mutable state
  forced:  WeakMap<Agent, number>               ← adapter-local mutable state
  listeners:
    tools/post-execute   → live fold (+ consumeInlineReminder ride-along)
    agent/pre-step       → user-source interjection reset
    agent/turn-stopping  → round settle | ladder steer | completion guard
    agent/session-start  → source==='resume'|'compact' → rebuild + forced.delete
    agent/created        → router restrict({allow})
    ctx.inject systemPrompt → verification-state rendering (read-only)
```

Mutable Orcana runtime state lives in TWO containers plus lifecycle/config
state owned elsewhere (engine private fields; adapter WeakMaps; the router
restriction inside DSH's tools service scoped to the agent; Cordis listener
registrations). Non-EngineEvent transitions exist (`endTurn`, `resetChains`,
uncalled `beginTurn`, forced/engines map writes, restriction install/dispose):
`EngineEvent` is the tool-observation input currency only.

Below Orcana sits the DSH durability stack this revision adds to the map:

```
DSH cold resume (rc.6):
  AgentLoop.resume → persistence.prepare(id)
    PersistenceCoordinator.prepare
      → serialize(prepareCore):
          backend.loadStored            (raw durable events, possibly crash tail)
          interruptedTurnClosers(events) (session/src/repair.ts)
      → serialize(commitPrepared):
          commitRepair(meta, tornMarker, closers)  ← synthetic closers become DURABLE
      → Session seeded with balanced = [...storedEvents, ...closers]
  → agent publish: agents.announce (= agent/created)
  → agent/session-start {source:'resume'}
  → Orcana listener reads agent.session.events  (RAW balanced log)
```

## Live Event Path

Unchanged from Rev.2 (verified again against rc.6):

- Construction site: `tools/post-execute` waterfall (dsh-governor :460);
  governor folds BEFORE `next()`.
- rc.6 pipeline: scheduler → `finalizeScheduledExecution` (dsh-tools
  index.js:3223) → `postExecute` (:3359); scheduler `final-result` outcomes
  bypass post-execute entirely (index.js:3002; types 301–303).
- Nested code-mode sub-dispatches ARE observed live with their INNER tool name
  (run_code bridge schedules nested executions through the same registry path;
  `createExecution` keeps `name`, sets `parent`; dsh-tools index.js:884–891,
  3008–3029) → a nested `write` reaches the governor as `mutation=true`.
- Downstream listeners may replace content or block after the fold
  (index.js:3359–3388).
- `MUTATION_TOOLS = {write, edit, str_replace_editor}` (:158): bash is never a
  mutation tool regardless of effect.

## Replay Event Path

Construction site: `agent/session-start` gated to `'resume' | 'compact'`
(dsh-governor :394–407). On rc.6 resume the flow is:

1. DSH persistence has ALREADY repaired the loaded log (see previous section):
   by the time the governor runs, `agent.session.events` is the BALANCED raw
   log — original events plus durable synthetic closers where the tail was
   open.
2. Governor reads `agent.session.events` (:396) — the RAW append-only log,
   NOT the model-facing surface projection (see Raw Log vs Surface below).
3. `sessionReplayEvents` keeps only `tool/call` and `tool/result` records in
   log order (:258–268) — synthetic closers of type step/end|turn/end are
   ignored; synthetic tool/results ARE consumed.
4. `translateSessionEvents` pairs results to pending calls via
   `message.source.callId ?? block.callId ?? block.toolCallId` (:274–305);
   pending entries are never deleted; only `{content, isError ?? false}` is
   forwarded to `toEngineEvent` (:296–300).
5. `ProgressFactEngine.rebuild` = fresh engine + N × `applyEvent` (core
   src:439–442) — no round boundaries during replay.

Publication order on resume is unchanged from Rev.2: `agent/created` fires
synchronously BEFORE `agent/session-start(resume)` (agent-loop publish order
@15148dbd9a), so the router restriction re-applies first. rc.6 reserves
`'clear'`/`'compact'` in `SessionStartSource` with no emitter yet — the
compact rebuild branch is dead code under lockfile semantics.

## DSH Cold-Resume Repair Layer (rc.6)

Native recovery facts produced by `packages/core/session/src/repair.ts`
(`interruptedTurnClosers`), invoked from
`packages/session/session-persistence/src/coordinator.ts` `prepareCore`
(coordinator.ts:892–931) and made durable by `commitRepair` (:934–957):

- Two distinct interruption codes exist:
  - `TOOL_NOT_STARTED` — an assistant tool request whose durable `tool/call`
    record never landed (crash between assistant message and call append;
    `callSeq === undefined` in the repair scan).
  - `TOOL_OUTCOME_UNKNOWN` — a durable `tool/call` EXISTS but no completed
    `tool/result` was durably recorded before the crash (`callSeq` present).
  These are different interruption classes and must not be conflated.
- For every pending tail call the repair appends a SYNTHETIC `tool/result`:
  - `isError: true`;
  - distinct guidance text per class ("interrupted after it was recorded…
    outcome is unknown… verify external state…" vs "interrupted before the
    Harness recorded it as started…");
  - `data.error = {name:'ToolOutcomeUnknownError', code:'TOOL_OUTCOME_UNKNOWN'}`
    or `{name:'ToolNotStartedError', code:'TOOL_NOT_STARTED'}`;
  - `surfaceOp: 'append'`, `sourceEventSeqs: [callSeq]` for started calls.
- It then synthesizes `step/end` (if a step was open) and
  `turn/end {reason:{kind:'interrupted'}}`.
- These closers are appended to the DURABLE log via `commitRepair` and then
  seed the resumed Session — they are first-class durable history, not
  in-memory-only patches. Owner boundary: these are DSH Session/Persistence
  native recovery facts, NOT an Orcana private ledger.

Consequence for this inventory: after a REAL cold resume there is no such
thing as an unpaired dangling `tool/call` for tail calls of the last turn —
each has a paired synthetic result. What remains true: earlier-turn dangling
calls cannot exist (turn boundaries clear them), and the repair only covers
the OPEN TAIL turn.

## Raw Session Event Log vs Session Surface

Two different things, both called "session" colloquially:

- **Raw Session Event Log** — `session.events`: readonly, append-only,
  deep-frozen authoritative history ("neither a cast nor ordinary JavaScript
  can rewrite durable history", dsh-session types index.d.ts:170–174). Both
  the ORIGINAL and any REPLACEMENT of a result remain in it.
- **Session Surface** — derived projection (`SessionSurface.nodes`,
  `replaceGeneration`; `foldSurface`). When compaction replaces a result, it
  APPENDS a new record citing the old one (`surfaceOp:{op:'replace'}`,
  `sourceEventSeqs:[seq]`); the surface fold makes the replacement SHADOW the
  original for future model-facing history while raw history keeps both.
- Verified compaction mechanism (rc.6
  `compaction-tool-result-pruner/src/index.ts` `pruneSession`): iterates
  CURRENT-SURFACE `tool/result` nodes, appends a `compaction/prune`
  shadow-price event, then appends the replacement `tool/result` with
  identical data except content, citing `surfaceOp replace`. NO rewrite of
  prior records occurs ("retaining the full original event in the append-only
  session log", pruner README). The pruner does NOT filter by tool type — any
  over-budget surface result qualifies, including successful mutation-tool
  results (compaction-basic invokes it under pressure;
  compaction-basic/src/index.ts:281–309).
- **Orcana consumes the RAW LOG**: the resume handler reads
  `agent.session.events` (:396), so both original and replacement records are
  visible to replay. Orcana has no surface awareness today.

## Live vs Replay Proven Equivalence

Three levels, unchanged from Rev.2 and re-verified:

A. Shared transition function — YES (same `toEngineEvent`, same `applyEvent`).
B. Event domain equivalence — NO (divergences below).
C. Full runtime semantic equivalence — NOT PROVEN; contradicted below.

Snapshot-equality tests pin projection equality only (adapter.spec.ts:120,
176; core.spec.ts:245); the projection excludes chain, TurnState, forced
budget, lifecycle state, and structured recovery identities.

## Known Live vs Replay Divergences

Reorganized this revision (D5/D6 split per mechanism; each item is current
behavior, not a defect ruling):

D1. Code-mode sub-dispatch effects: live sees nested executions individually;
    their durable records (`tool/code-dispatch*`) are filtered out of replay.
    (executor-observed real-log counts: 48 code-dispatch vs 32 tool/call in
    one run_code-heavy session.)

D2. Stale-PASS resurrection via missed nested mutation (runtime-proven):
    PASS@gen0 → run_code nested write (live gen→1) → crash/resume → replay
    ignores code-dispatch → rebuilt gen=0 → historical PASS presents CURRENT.

D3. Post-execute replacement/block by downstream listeners: live folds
    PRE-decision content; the durable record is POST-decision. Mechanism
    proven; deployed frequency unmeasured.

D4. Replay-only events: `final-result` pipeline failures bypass post-execute
    live yet still materialize logged `tool/result`s.

D5. **Surface replacement semantics (corrected)**: compaction does NOT
    rewrite raw history. It legitimately produces a SECOND durable
    `tool/result` for the SAME callId (append + shadow). Any claim of "hash
    drift caused by rewriting" resolves to this append mechanism.

D6. **Replay treats a valid replacement as another result (runtime-proven)**:
    because pending entries are never deleted and raw-log both-records are
    fed in, ONE logically-replaced call yields TWO EngineEvents
    (experiment I: 2 events from [original, replacement]). For a replaced
    MUTATION success this DOUBLES the generation advance: one logical write
    replays as generation += 2 (experiment J). Replacement also increments
    TurnState observations twice, can overwrite a same-command receipt with
    the replacement hash (verification case), and can alter trailing inline
    streak state.

D7. **Accidental physical duplicates** (persistence bug/malformed log):
    mechanism consequences identical to D6 at the governor layer, frequency
    UNKNOWN (none found in inspected samples). Current translator cannot
    distinguish a valid surface replacement from an accidental duplicate —
    both collapse into the same double-application behavior; the distinguishing
    metadata (`surfaceOp`, `sourceEventSeqs`, `compaction/prune`) exists in
    the raw record shape but is outside `ReplayEvent`.

D8. Structured recovery identity loss: DSH's synthetic results carry
    `data.error.{name,code}` (`TOOL_OUTCOME_UNKNOWN`/`TOOL_NOT_STARTED`);
    `ReplayEvent` models only `message`, and translation forwards only
    `{content, isError}` — the codes never reach `EngineEvent`. DSH truth is
    preserved; the Orcana projection drops the identity.

## State Inventory

Column set deliberately avoids forward-looking classification labels; it
records owner, flow, lifetime, today's durability, today's replay behavior,
and observed caveats.

governor-core per-engine fields (class at core src:223; fields 224–232):

| State | Written by | Read by | Lifetime | Durability today | Replay behavior today | Observed caveat |
| --- | --- | --- | --- | --- | --- | --- |
| generation (:228) | `onMutation()`; applyEvent when `event.mutation` | render/guard/classify/isStale | engine instance | none (in-memory) | rebuilt from replay-visible mutation results | live writer domain ⊃ replay writer domain (nested code-mode mutations lost; unknown-outcome mutations not counted — see H) |
| ring (:229, window 8) | push/shift/prune in applyEvent | classify, snapshot | sliding window | none | rebuilt; hashes follow raw-log content incl. replacements (double observations, D6) | replacement duplicates occupy window slots |
| receipts (:230, latest-wins per command) | verification branch (:290–303); setter (:406) | render, guard | engine instance | none | recomputed; a replaced verification result OVERWRITES the receipt with the replacement hash/status | unknown-outcome verifications land as FAIL (G), not UNKNOWN |
| zero-progress chain (:231) | endTurn/resetChains | ladder verdicts | process | none | rebuild leaves 0; whether preservation matters unresolved | first post-resume settle judges polluted aggregate |
| turn/TurnState (:232, iface :545) | lazy create in observeTurn (:319); cleared by endTurn/beginTurn/resetChains | reminder, settle | one round when boundary-driven; UNBOUNDED across rebuild | none | rebuild folds ALL history into one unsettled TurnState (sticky flags; armed reminder survives) | runtime-proven pollution |

Adapter-local state (dsh-governor :370–372):

| State | Written | Read | Cleared | Durability today | Replay behavior today | Caveat |
| --- | --- | --- | --- | --- | --- | --- |
| engines WeakMap | lazy create; rebuild swap (:402) | all handlers+inject | GC w/ Agent | none | replaced wholesale at session-start(resume) | 'clear'/'compact' have no emitters in rc.6 |
| forced budget WeakMap | +1 per steer (:506,:532) | budget checks | user pre-step (:489); resume (:403) | none | deleted at resume; logged plugin steers exist but unused | |

Router restriction: installed per agent at `agent/created` (:441–455) into
DSH tools service; agent-scope-owned disposal; config-driven; verified to
re-fire before session-start(resume) on rc.6. Config knobs (schema :96–152 +
bundle row) are mount-time configuration. Plugin registrations are
Cordis-owned (:333,:534–536).

Generation writer domains (explicitly split):

- LIVE writer set: every post-execute EngineEvent with `mutation=true` —
  root write/edit/str_replace_editor AND nested code-mode ones (inner-name
  dispatches).
- REPLAY writer set: successful mutation results visible after
  `sessionReplayEvents` filtering — root records only (code-dispatch filtered),
  PLUS each surface replacement counted again (D6), and EXCLUDING
  unknown-outcome mutations (synthetic isError=true ⇒ mutation=false).
  Therefore rebuilt-generation ≠ live-generation whenever nested mutations or
  replaced mutation results exist; the State Inventory and the code-mode
  divergence say the same thing and do not contradict each other.

## Adapter-Local State

Covered in the table above; no other mutable module-level state exists in
either package (no timers/caches/fs).

## DSH-Native Durable Facts

Facts Orcana reads (or could read) from the locked-version stack:

- `tool/call {turn,step,callId,name,arguments(raw string)}` (dsh-session types
  283–290).
- `tool/result {message{source{kind:'tool',callId},content:[ToolResultBlock]},
  error?,meta?}` (types 299–310; dsh-llm message/types) — `error` carries
  structured failure identity INCLUDING recovery codes on synthetic results.
- Synthetic recovery records (repair.ts): synthetic tool/result with
  `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED` + `data.error` identity +
  sourceEventSeqs citation; synthetic `step/end`; synthetic
  `turn/end{interrupted}` — made durable by coordinator `commitRepair`.
- Surface replacement protocol: appended `tool/result` with
  `surfaceOp:{op:'replace',start,end}` + `sourceEventSeqs:[origSeq]`,
  preceded by adjacent `compaction/prune` shadow-price event (pruner src).
- Exit-status markers `[exit code:N]` / `[killed by signal:X]` /
  `[timed out after…]` — dsh-shell renderer contract (lib/index.js:13–14,
  32–37). NOTE: synthetic recovery text contains NONE of these markers.
- `assistant/message` texts (guard rule 3 input), `user/message` source kinds
  (interjection predicate), crash-tolerant `turn/end{interrupted}` reason
  (present, unconsumed by Orcana).
- `session/end-seed`, request headers — unconsumed.
- Checkpoint flush ownership lives in `dsh-session-checkpoint-policy`
  (not audited here).

Real-log evidence discipline: the pcba session sample cited in the Evidence
Index is EXECUTOR-OBSERVED locally, not reproducible from the repository
alone; repository-only proofs come from pinned dependency artifacts.

## EngineSnapshot Reality

Unchanged from Rev.2, re-verified:

- `{generation,ring,receipts}` (core src:82–87) is NOT durable storage: no
  fs/db/session writer exists; production uses are read-models
  (snapshot().receipts at dsh-governor :426 inject and :529 guard); `restore()`
  is test-only. One durable truth (raw log + its durable repairs) and one
  reconstruction path (rebuild) exist.
- Projection omits chain, TurnState, forced budget, lifecycle state, world
  state, and structured recovery identities — so snapshot equality proves
  projection equality only.

## Existing Recovery Capability

Fine-grained matrix under rc.6 semantics. New rows cover this revision's
scope; prior rows re-verified.

| Capability | Current result |
| --- | --- |
| DSH cold-resume repair of open tail (synthetic closers, durable) | SUPPORTED (repair.ts + coordinator prepareCore/commitRepair; rc.6) |
| DSH distinction TOOL_NOT_STARTED vs TOOL_OUTCOME_UNKNOWN | SUPPORTED (distinct codes/texts/sourceEventSeqs behavior) |
| DSH TOOL_OUTCOME_UNKNOWN preservation across resume | SUPPORTED (closers committed durably, then seeded) |
| Orcana preservation of recovery error identity (codes) | NOT_SUPPORTED (ReplayEvent/translation drop `data.error`; D8) |
| Dangling-call fact survival into Orcana replay | PARTIAL (pairing survives via synthetic result; identity/class does not) |
| Unknown verification outcome projection | FAILS TODAY: DSH UNKNOWN projects to receipt status `fail` (experiment G) — interrupted=false (no markers), exitCode absent, isError=true ⇒ 'fail' |
| Unknown mutation effect reconstruction | NOT_SUPPORTED as ambiguity: synthetic isError ⇒ mutation=false ⇒ generation unchanged; side effect MAY have occurred but is invisible (H) |
| Root tool call/result reconstruction | PARTIAL (shapes verified; isError optional default-false; replacement double-count D6) |
| Generation from replay-visible ROOT mutation successes | SUPPORTED (deterministic) |
| Complete workspace-mutation reconstruction | NOT_SUPPORTED (code-mode loss D1/D2; unknown-mutation invisibility H; bash-class effects never counted) |
| Verification receipts from replay-visible ROOT bash results | SUPPORTED (with D6 overwrite caveat) |
| Complete live verification-state reconstruction | PARTIAL (nested-in-run_code verifications and replaced results deviate) |
| Freshness vs INTERNAL generation | SUPPORTED (deterministic comparison/rendering) |
| Freshness vs ACTUAL workspace/world | PARTIAL (generation gaps: bash effects, nested effects, unknown effects) |
| Ring reconstruction | PARTIAL (structure yes; contents shifted by replacements D6 and content drift) |
| Zero-progress chain recovery | NOT_SUPPORTED (resets; significance unresolved) |
| Clean turn-local reset at resume | NOT_SUPPORTED — CONTRADICTED BY CURRENT REBUILD (Rev.2 runtime proof stands) |
| Forced-continuation recovery | NOT_SUPPORTED (deleted; logged steers unused) |
| Completion DECISION recomputation | SUPPORTED (stateless per stop; inputs from rebuilt state + durable text) |
| Completion CORRECTNESS after resume | PARTIAL (inputs degraded by D1/D2/D6/D8/G/H) |
| Recorded timeout/signal → unknown receipts | SUPPORTED (marker contract intact in real result text) |
| Session raw-log awareness | SUPPORTED as consumption (Orcana reads raw events) — but without distinguishing raw-vs-surface roles |
| Session surface replacement awareness | NOT_SUPPORTED (no surfaceOp/sourceEventSeqs consumption anywhere in Orcana) |
| Compaction replacement-aware replay | NOT_SUPPORTED (replacement replays as second event; D6) |
| Accidental duplicate handling | NOT_SUPPORTED (indistinguishable from replacement at governor layer; D7) |
| Valid same-call replacement handling | NOT_SUPPORTED as distinct handling (collapses into double-apply; D6) |
| Router reapplication on rc.6 resume | SUPPORTED (VERIFIED publication order) |
| Real crash/resume end-to-end correctness (production) | NOT_SUPPORTED as a proven property (no apply()-level resume test; divergences above unmeasured in wild) |

## Turn / Round State Reality

Rev.2 findings stand (re-verified, unchanged): rebuild has no boundaries
(core :439–442); observeTurn lazily creates ONE accumulated TurnState
(:319); sticky mutation/significant/verifyNew/verifyPass; trailing streak
arms inlineReminder which SURVIVES resume and fires on the first live
observation; first settle judges the mixed aggregate
(`zeroProgress:false,chainLength:0` for a genuinely pure-repeat first round).
Whether this matters for governance quality is unresolved here.

## Completion-State Reality

- Mechanism: eligibility recomputed per stop from
  `{generation, receipts} ∪ lastAssistantText(session)` (dsh-governor
  :499–534; completionViolations core :697+). Recomputation is
  resume-structural.
- Correctness boundary widened by Rev.3: an unknown verification outcome
  enters as FAIL (G), which additionally triggers guard RULE 2
  ("verification X is failing") against a DSH-UNKNOWN command — a false-
  failing assertion layered on the freshness gaps already documented. Inputs
  otherwise inherit D1/D2/D3/D4/D6/D8. Mechanism SUPPORTED; correctness
  PARTIAL.

## World State Boundaries

- Filesystem/git/process/external services are world state; Orcana's only
  linkage is `generation` — a COARSE RUNTIME FACT derived from recognized
  mutation-tool SUCCESSES, not a workspace version. Proven gap cases: bash
  mutations (never counted), nested code-mode mutations (live-only), and
  CRASHED mutations whose outcome DSH preserves as UNKNOWN (side effect may
  have occurred; Orcana sees neither success nor ambiguity — experiment H).
  Outcome ambiguity must be stated as "may": the synthetic record asserts
  nothing about what the interrupted execution did.
- Background processes, unlogged external effects, clock/env/provider state:
  outside any reconstruction path here.

## Unknown / Ambiguous Execution

Corrected two-case picture:

- Case A — outcome durably AMBIGUOUS with markers: a real `tool/result`
  containing `[timed out after …]`/`[killed by signal: X]` reconstructs to
  status `'unknown'` (interrupted dominates). Ambiguity preserved as
  ambiguity. SUPPORTED.
- Case B — outcome unknown BY CRASH (this revision's correction): the REAL
  resume path repairs the tail with a synthetic `tool/result`
  (isError=true + `TOOL_OUTCOME_UNKNOWN`/`TOOL_NOT_STARTED` identity), so the
  FACT of "started-but-unknown" survives durably. What fails is the ORCANA
  PROJECTION: the identity is dropped (D8) and the rendered text matches no
  interruption marker, so `receiptStatus` degrades UNKNOWN→FAIL for shell
  verifications (G) and mutation-truth becomes invisible for mutation tools
  (H). Rev.2's "silently omitted" described only unrepaired RAW traces fed
  directly to the translator — not the production resume path.

## Counterexample Register (all executor-runtime-proven unless noted)

| ID | Scenario | Observed current result |
| --- | --- | --- |
| A | PASS@gen0 → run_code nested write → crash/resume | rebuilt gen=0; stale PASS presents CURRENT |
| B | history ends with ≥2 identical reads; resume | armed reminder fires on FIRST live observation; first settle judges mixed aggregate (`zeroProgress:false` for genuinely pure-repeat round) |
| C | dangling `tool/call` fed as RAW unrepaired trace | 0 EngineEvents (translator-only view; superseded for real resumes by G/H — see Case B) |
| D | duplicate tool/result for one mutation | generation +2 for one logical mutation; ring/turn double-count |
| E | `bash sed -i …` workspace change | generation unchanged; internal freshness unaffected (receipt stays "fresh") |
| F | downstream post-execute replace/block | live hash ≠ durable hash (mechanism proven in rc.6 code; frequency unmeasured) |
| G | repaired UNKNOWN verification (`npm test` call durable, crash, TOOL_OUTCOME_UNKNOWN closer) | Orcana receipt status = **FAIL**, interrupted=false, exitCode=undefined |
| H | PASS@gen0 → `write` call durable → crash → TOOL_OUTCOME_UNKNOWN repair | generation stays 0; pass@gen0 still "fresh"; side effect may have occurred — invisible either way |
| I | one logical call + surface replacement (two durable results) | translateSessionEvents emits **2** EngineEvents |
| J | mutation success + its surface replacement | 2 mutation events applied → rebuilt generation = **2** for one logical write |

## Unknowns

1. Checkpoint-policy flush timing relative to post-execute (tail-loss bound).
2. Background eventual-result semantics (whether later observable result
   events exist for background acks).
3. Deployed frequency of downstream post-execute replacement/blocking.
4. Frequency of ACCIDENTAL physical duplicates in real logs (valid
   replacements are mechanism-VERIFIED; see D6 vs D7).
5. Deployment/version skew vs lockfile rc.6 (lifecycle order, repair layer,
   pruner behavior are rc.6-verified; other versions inherit their own
   semantics).

Execution environment note (not a runtime unknown): Master Plan document not
present locally this pass — see Baseline.

## Candidate Gaps

Factual gaps only; no design proposed:

1. Orcana replay drops DSH's structured recovery identity
   (`TOOL_OUTCOME_UNKNOWN`/`TOOL_NOT_STARTED`): current projection preserves
   neither the code nor the unknown-ness for shell verifications.
2. Unknown verification outcome lands as FAIL receipt → feeds completion-guard
   rule 2 as a failing verification (G).
3. Unknown mutation outcome leaves generation frozen; freshness assertions
   built on it are insensitive to possible side effects (H).
4. Valid surface replacements replay as additional full observations (I/J):
   duplicated ring entries, receipt overwrite, doubled generation advance for
   replaced mutation successes.
5. Replacement vs accidental duplicate are indistinguishable at the governor
   layer; distinguishing metadata exists in raw records but outside
   ReplayEvent.
6. Orcana consumes the raw log without any surface-role modeling; shadowed
   originals are replayed alongside their replacements.
7. Carried from Rev.2 (still true): architecture.md stale "pending H1";
   benchmark analyze.mjs second translation (own pairing, step/end boundary,
   raw isError, no code-dispatch, no replacement awareness) — not a recovery
   authority; restore()/beginTurn() uncalled; forced history discarded at
   resume; snapshot tests bound to projection equality; no apply()-level
   resume test.

## Evidence Index

Repository (`research/durable-recovery-r0-a`):

| Conclusion | path | location |
| --- | --- | --- |
| Engine fields/observeTurn/endTurn/rebuild | packages/governor-core/src/index.ts | 223–232, 312–319, 367–382, 439–442 |
| snapshot/restore; EngineSnapshot | packages/governor-core/src/index.ts | 82–87, 421–437 |
| completionViolations | packages/governor-core/src/index.ts | 697+ |
| MUTATION_TOOLS/toEngineEvent | packages/dsh-governor/src/index.ts | 155–163, 206–236 |
| ReplayEvent WITHOUT data.error field | packages/dsh-governor/src/index.ts | 243–256 |
| sessionReplayEvents filter | packages/dsh-governor/src/index.ts | 258–268 |
| pairing, NO pending.delete, forwards only {content,isError??false} | packages/dsh-governor/src/index.ts | 274–305 (279, 285, 296–300) |
| resume handler reads RAW agent.session.events | packages/dsh-governor/src/index.ts | 394–407 (396) |
| engines/forced; router; pre-step; turn-stopping | packages/dsh-governor/src/index.ts | 370–372, 441–455, 486–493, 499–534 |
| projection-equality-only tests | adapter.spec.ts / core.spec.ts | 120,176 / 245 (restore test-only 227–228) |
| benchmark second translation | benchmark/runner/analyze.mjs | 186–227 |
| lockfile pins | pnpm-lock.yaml | dsh-* @0.1.0-rc.6 |

Locked rc.6 dependencies & monorepo @15148dbd9a:

| Conclusion | artifact | location |
| --- | --- | --- |
| TOOL_NOT_STARTED / TOOL_OUTCOME_UNKNOWN constants; synthetic closers incl. data.error identity, texts, sourceEventSeqs; step/end + interrupted turn/end | packages/core/session/src/repair.ts (@15148dbd9a) | whole file (13–16, 19–133) |
| prepareCore invokes interruptedTurnClosers; balanced seed; commitRepair persists closers | packages/session/session-persistence/src/coordinator.ts (@15148dbd9a) | 720–768, 892–931, 934–957 |
| session.events = readonly append-only frozen raw log | dsh-session lib/types/index.d.ts (installed) | 170–174 |
| SessionSurface.nodes/replaceGeneration; foldSurface | dsh-session lib/types/surface.d.ts (installed) | 80–95 |
| pruner APPENDS replacement (surfaceOp replace + sourceEventSeqs) after shadow-price event; original retained; NO tool-type filter | packages/compaction/compaction-tool-result-pruner/src/index.ts (@15148dbd9a) | pruneSession body; README:5 |
| compaction-basic invokes pruneSession under pressure | packages/compaction/compaction-basic/src/index.ts (@15148dbd9a) | 281–309 |
| postExecute replace/block; final-result bypass; nested inner-name dispatches | dsh-tools lib/index.js + types (installed) | 3359–3388; 2997–3004,301–303; 884–891,3008–3029 |
| SessionEventMap shapes; interrupted turn-end | dsh-session lib/types/types.d.ts | 223–354 |
| announce→agent/created precedes session-start(resume); clear/compact reserved w/o emitter | harness monorepo @15148dbd9a | agent/src/index.ts announce; agent-loop/src/index.ts 556–568,699–703; agent README:121 |
| exit-marker owner | dsh-shell lib/index.js | 13–14,32–37 |

Runtime experiments (executor-run; scripts import the real repo sources):

| Experiment | Command | Result |
| --- | --- | --- |
| G | `/tmp/r0a-rev3.mts` (case G) via `node --experimental-strip-types` | 1 EngineEvent; isError=true; interrupted=false; exitCode=undefined; receipt npm-test = **FAIL** |
| H | same script (case H) | generation 0; pass@gen0 stale?=false |
| I | same script (case I) | 2 EngineEvents from one logical replaced call |
| J | same script (case J) | 2 mutation events; rebuilt generation = 2 |
| A/B/C/D/E (Rev.2 set) | `/tmp/r0a-experiment*.mts` (still on disk) | unchanged results, re-confirmed this pass |

Executor-observed local data (not repository-reproducible): pcba session log
`~/.dsh/sessions/--home-fuqiang-projects-pcba--/3f326596-f2e7-4c7e-9701-48da608a908e/session.jsonl.zstd`
(counts: 48 code-dispatch vs 32 tool/call; shapes match pinned types).

## R0-A Status

Rev.3 complete: cold-resume repair layer, recovery codes, raw-log/surface
boundary, and replacement semantics integrated; all four required
counterexamples (G/H/I/J) runtime-proven; capability matrix extended; Rev.2
conclusions re-verified and retained except where corrected above. Answers to
the standing self-check: (1) DSH repairs the tail before publish and commits
closers durably; (2) dangling calls appear in `agent.session.events` as
paired synthetic results carrying error identity; (3) DSH UNKNOWN arrives at
Orcana as FAIL for shell verifications — projection downgrade; (4) compaction
appends replacements, raw history untouched; (5) Orcana consumes the RAW log
(`agent.session.events`), not the surface; (6) twice per replaced call;
(7) indistinguishable at the governor layer today; (8) YES — live ⊋ replay
(nested losses, replacement doublings, unknown exclusions); (9) no R0-B
classification frozen; (10) no implementation design proposed. Independent
re-audit owes the next judgment.
