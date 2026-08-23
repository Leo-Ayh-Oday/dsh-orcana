# R0-B — Reconstructability & World-Drift Matrix

Classification of every recovery-relevant state/fact identified in R0-A
(`docs/recovery/R0-A-RECOVERY-STATE-INVENTORY.md`, accepted at `215595e`,
audit verdict PASS_WITH_RISK / ACCEPT_R0_A). This artifact answers:

> What is durable, what is derived, what is resettable, what must be
> re-observed, and what remains unknown?

It does NOT decide correctness contracts (R0-D), crash-boundary analysis
(R0-C), gap priority (R0-E), or any recovery architecture. Where evidence is
insufficient, items are marked AMBIGUOUS / UNRESOLVED instead of guessed.

## Baseline

- Branch: `research/durable-recovery-r0-b` (created from the accepted R0-A tip)
- Starting HEAD: `215595ea3cc0c40ff14d61a1f3ef10ce9ad494a0` (= accepted R0-A
  commit; working tree clean at start; `git merge-base --is-ancestor` confirms
  it in history)
- Source seams audited in R0-A are UNCHANGED (`git diff --stat 215595e --
  packages/ benchmark/` empty), so R0-A line citations remain valid; spot
  re-checks performed anyway (repair.ts symbols, byte-compare of the five key
  files against an independent checkout — all IDENTICAL).
- Lockfile basis unchanged: `@deepseek-ai/dsh-*` 0.1.0-rc.6.
- Execution environment note (unchanged): Master Plan document not available
  locally; directives' quoted principles applied as stated.
- Fresh verification this pass: governor-core specs 4 files / 72 tests PASS;
  dsh-governor targeted specs (adapter/p2-policy/p4-policy/p5-policy) 4 files /
  30 tests PASS; runtime experiments G/H/I/J and A/B/D/E re-run with identical
  results (commands in Evidence Index).

## A. Classification Legend

Six classes used below. These describe WHAT IS, today, under rc.6 lockfile
semantics; they are not durability mandates.

- **A. authoritative native durable fact** — exists verbatim in the DSH raw
  Session event log (or its durable repairs); owner is DSH
  Session/Persistence. Survives restart by construction.
- **B. deterministic derived state** — fully determined by authoritative
  history plus a deterministic algorithm; no heuristics, no world input.
  Two independent questions apply and are kept separate everywhere below:
  (i) is the INFORMATION in history? (ii) does current Orcana code derive it
  correctly from what its projection receives?
- **C. derived optional / heuristic state** — derived by a deliberately
  lossy/heuristic mechanism (sliding windows, counters, thresholds) whose
  purpose is behavior quality; losing it costs efficiency or steering
  quality, not factual truth.
- **D. ephemeral turn / process state** — process-local containers or
  round-scoped accumulators; not meaningful across restarts except as
  re-derived from history/config.
- **E. external world state requiring observation** — filesystem, git,
  process, service reality; no amount of Session history can prove current
  values.
- **F. ambiguous / unresolved** — classification itself blocked on missing
  evidence; recorded honestly, deferred.

Standing rule applied throughout: **"fact exists durably" ≠ "Orcana currently
reconstructs the fact correctly"**, and **"runtime-derived truth" ≠ "actual
world truth"**.

## B. Reconstructability Matrix

Legend for the two rebuild columns:
`Info∈H` = information exists in authoritative history;
`Rebuilt✓/~/✗` = current Orcana implementation reconstructs it correctly /
partially / not at all.

### A-class rows (authoritative native durable)

| State / Fact | Owner / Source | Class | Durable | Info∈H | Rebuilt | World obs required | Live vs Replay notes | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DSH session identity/header | DSH Session | A | yes | trivially | n/a (engine never needs it) | no | n/a | dsh-session types index.d.ts:40+ |
| User task / durable messages | DSH (user/message) | A | yes | yes | not folded into engine state (observation-only design; interjection reset reads live inbox source kinds, :486–493) | no | same both paths | src/index.ts:486–493 |
| Assistant tool requests | DSH (assistant/message tool-call blocks) | A | yes | yes | not consumed by engine (tracks observations, not requests); provenance input for TOOL_NOT_STARTED repair | no | same | repair.ts:44–48 |
| tool/call records | DSH | A | yes | yes | YES — paired deterministically when result exists (:279–296) | no | raw-string args parse parity verified (adapter.spec.ts malformed-JSON case) | src/index.ts:279; types 283–290 |
| tool/result (original records) | DSH | A | yes | yes | PARTIAL — hash reflects durable (post-decision) bytes; isError silently defaults false when absent | no | live folded PRE-decision content (D3) | src/index.ts:285–300; dsh-tools index.js:3359–3388 |
| Synthetic crash-repair events | DSH persistence (commitRepair) | A | yes — closers become durable | yes (they ARE history) | PARTIAL — paired & folded, but recovery identity dropped (G; see Projection-Loss) | no | replay-only records (exist precisely because resume happened) | coordinator.ts:892–957; repair.ts |
| TOOL_OUTCOME_UNKNOWN semantics | DSH repair layer | A | yes (durable synthetic result + error identity) | yes | WEAKENED — EngineEvent exists; code lost; shell-verification receipt degrades UNKNOWN→FAIL (experiment G) | no | replay-only | repair.ts:100–121; /tmp/r0a-rev3.mts |
| TOOL_NOT_STARTED semantics | DSH repair layer | A | yes (durable synthetic result; NO durable tool/call by definition) | yes | ✗ NOT RECONSTRUCTED AT ALL — translator finds no pending call ⇒ orphan-skip ⇒ zero EngineEvents (Correction A; distinct from OUTCOME_UNKNOWN) | no | replay-only | repair.ts:118–119; translateSessionEvents orphan path :285–296 |
| surfaceOp replace + sourceEventSeqs metadata; compaction/prune events | DSH compaction protocol | A | yes | yes | ✗ dropped — outside ReplayEvent; replacements indistinguishable from accidental duplicates at governor layer | no | raw-log both-records fed; double-application (D6) | pruner src; src/index.ts:243–256, 279–305 |
| turn/end {interrupted} reason; step/end | DSH | A | yes | yes | not consumed (filtered out of replay feed; no consumer) | no | filtered | src/index.ts:258–268; types 162–166 |
| tool/code-dispatch records (nested name/isError/content/subCallId) | DSH tools bridge | A | yes | yes — records carry enough to identify nested outcomes (CodeDispatchLog: name,isError,content) | ✗ dropped by sessionReplayEvents filter (nested mutation/verification facts lost to rebuild) | effects-themselves are world state | live observes executions directly; replay loses them (D1/D2) | CodeDispatchLog types index.d.ts:239–252; src/index.ts:258–268 |

### B-class rows (deterministic derived)

| State / Fact | Owner / Source | Class | Durable | Info∈H | Rebuilt | World obs required | Reset consequence | Live vs Replay notes | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Session Surface projection | DSH (foldSurface) | B | derived, not independently durable | yes (fold of full log) | Orcana never consumes the surface — it consumes the RAW log (superset incl. shadowed originals) | no | n/a | raw ⊇ surface for results; shadowed originals replayed (D5/D6) | surface.d.ts:80–95; src/index.ts:396 |
| Root call/result identity pairing | Orcana translation | B | derived | yes (for pairs present in feed) | YES for replay-visible pairs; orphans skipped; NOT_STARTED results unpairable (Correction A) | no | n/a | orphan/duplicate asymmetries | src/index.ts:274–305 |
| Verification receipts (command/status/generation/callId) over a GIVEN event stream | Orcana engine | B | no | yes for replay-visible root bash results | YES mechanically, with input-domain distortions: synthetic-unknown lands as FAIL (G); replaced results overwrite receipt (D6); nested verifications absent (D1) | CURRENT world freshness: yes (see World-Drift) | loss of receipt set → freshness/completion inputs wrong until re-observed | streams non-equivalent (Correction B) | core :290–303, :406; experiments G/J |
| Workspace generation over a GIVEN event stream | Orcana engine | B | no | yes for replay-visible successful root mutations | YES mechanically; VALUE diverges live vs rebuild — writer streams are NON-EQUIVALENT, neither subsumes the other (live-biased: nested code-mode, pre-decision hashes; replay-biased: final-result failures, replacement second-applications, synthetic results) | ACTUAL mutation truth: yes (world) | reset to 0 erases all mutation memory → freshness claims unfounded until re-established | Correction B wording adopted; `live ⊃ replay` NOT claimed | experiments A/H/J; Rev.3 writer-domain split |
| Evidence freshness relative to internal generation (isStale + STALE render) | Orcana pure functions | B | no | yes | YES — deterministic comparison/rendering (p3.spec) | meaning requires world check (internal-fresh ≠ world-fresh) | n/a | same fn both paths | core isStale/renderVerificationState; p3.spec.ts |
| Completion eligibility / violations | Orcana guard | B | no | inputs: text=A durable; gen/receipts=B-derived | recomputed each stop — deterministic over (possibly degraded) inputs; unknown-verification enters as FAIL → rule-2 fires spuriously (G) | truthfulness ultimately needs world | n/a | text scan reads durable log (resume-safe mechanism) | dsh-governor :499–534; core :697+ |

### C-class rows (derived optional / heuristic)

| State / Fact | Owner | Class | Durable | Info∈H | Rebuilt | World obs | Reset consequence | C/E/N | Notes / Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fingerprint ring (window 8) | Orcana engine | C | no | partially — window eviction intentionally discards older fingerprints; replacement doubles entries (D6) | rebuilt, contents shifted vs live-era | no | brief blind window for repeat detection | Efficiency | core :229, 267–285; experiment J |
| Zero-progress chain | Orcana engine | C | no | derivable IF round boundaries were replayed (turn/stopping settlements are NOT in the event domain) | ✗ resets to 0; additionally first post-resume verdict computed over polluted aggregate (B-experiment) | no | ladder thresholds reached later → fewer/later steers | Efficiency (no false-truth path found — ladder gates steering only) | core :367–382, :439–442; experiment B |
| Inline-repeat reminder state (armed/fired) | Orcana engine (TurnState field) | C | no | trailing-streak derivable from tail of history | ✗ mis-derived: reminder ARMED FROM HISTORY fires on first live observation post-resume (B) | no | n/a (mis-fire is the observed behavior) | Efficiency / behavior quality | experiment B |
| Forced-continuation budget | Orcana adapter WeakMap | C | no | RAW MATERIAL durable (plugin-source steers logged) but nothing counts them back | ✗ deleted at resume (:403) | no | more steer headroom; NOTE budget ALSO gates completion-guard steering (:518) — reset increases guard availability | Efficiency; possibly correctness-positive direction via guard availability | src :370–372, :403, :506, :518, :532 |
| repeatedPattern (round's last repeat) | Orcana engine | C | no | derivable per round IF boundaries existed | ✗ polluted: may name a historical pattern (Rev.2 experiment) | no | strong-steer text quality only | Efficiency | core :332–334; experiment B |

### D-class rows (ephemeral turn/process state)

| State / Fact | Owner | Class | Durable | Rebuilt | World obs | Reset consequence | C/E/N | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TurnState (observations/mutation/significant/verifyNew/verifyPass/streak/fingerprint/reminder/fired) | Orcana engine | D | no | ✗ currently rebuilt INCORRECTLY — single polluted aggregate instead of per-round states (Rev.2 runtime proof, re-confirmed) | no | clean per-round derivation WOULD be correctness-neutral (first verdict measured fresh); CURRENT pollution distorts first settle | Efficiency / behavior quality | core :232,:312–355,:439–442; experiment B |
| engines WeakMap registry | Orcana adapter | D | no | swapped wholesale at resume (:402) | no | none | Neither | src :370–372 |
| Router restriction (process/scope-local install) | config → DSH tools service scope | D | no | YES — re-applied at agent/created BEFORE session-start(resume) (VERIFIED rc.6 order) | no | none observed | Neither | src :441–455; agent-loop publish order @15148dbd9a |
| Plugin listener registrations / Cordis lifecycle | Cordis | D | no | re-registered on plugin mount | no | none | Neither | src :333, :534–536 |

### E-class rows (external world requiring observation)

| State / Fact | Owner | Class | Durable(session) | Rebuildable | World obs required | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Filesystem contents | world | E | no | never from history | YES | World-Drift Matrix below |
| git HEAD / index / worktree | world | E | no | never | YES | below |
| Running/background processes | world | E | acks maybe logged; lifecycle unresolved (Unknown-2) | never fully | YES | below |
| External services / remote APIs | world | E | only interaction traces | never current state | YES | below |
| Possible side effect after TOOL_OUTCOME_UNKNOWN | world (ambiguity durably preserved BY DSH, unresolvable by Orcana) | E (fact-of-ambiguity = A) | the ambiguity is durable; its RESOLUTION never is | no | YES — external verification is the only resolver | repair.ts text; experiment H |
| Workspace changes while Orcana down / between observations | world | E | no | no | YES | below |
| Actual current validity of past verification evidence | world | E | historical pass is durable fact; CURRENT validity is not | no | YES after any later mutation (stale-PASS resurrection, experiment A) | experiments A/E/H |

### F-class rows (ambiguous / unresolved)

| Item | Why unresolved | Effect on this matrix |
| --- | --- | --- |
| Whether preserving chain/budget/TurnState across restart has governance value | no correctness evidence either way; depends on future policy decisions out of R0-B scope | reset-safety rows marked AMBIGUOUS where value-judgment required |
| Accidental physical duplicate frequency | no representative sample found | D7 stays mechanism-level |
| Checkpoint flush timing (tail-loss bound) | owner package not audited | bounds "info∈H" for crash-tail moments; classifications unaffected except crash-moment edge |
| Background eventual-result lifecycle | no emitter evidence either way in audited sources | background row stays E/F hybrid |
| Downstream post-execute replace/block frequency | mechanism proven; wild frequency unmeasured | D3 stays conditional |
| Deployed DSH vs lockfile rc.6 | deployment inventory outside repo | all "rc.6-verified" tags conditional on lockfile discipline |
| Whether tool/code-dispatch content suffices for FAITHFUL nested-verification receipts | records carry name/isError/content (types :239–252) but end-to-end receipt fidelity unverified | row kept at "facts exist; reconstruction absent" — no stronger claim |

## C. World-Drift Matrix

Facts that historical Session truth CANNOT prove, however complete. For
each: what history proves / cannot prove / must be freshly observed / unsafe
to assume / impact on completion correctness.

| Drift subject | History CAN prove | History CANNOT prove | Must be freshly observed | Unsafe to assume | Completion-correctness impact |
| --- | --- | --- | --- | --- | --- |
| Filesystem contents | that certain write/edit tools RETURNED success at some seq; result text snapshots | current file state; post-return modifications (by later commands, other actors, or the user) | current contents relevant to task claims | that a successful write still holds; that untracked changes didn't occur | HIGH — "file X contains Y" claims need fresh reads |
| git HEAD | that commit/checkout commands succeeded historically | current HEAD (later commands/external git use) | `git rev-parse HEAD` equivalent fact | that workspace is at the historically-seen commit | HIGH for repo-state tasks |
| git index / worktree status | nothing direct (status output snapshots at most) | current staged/untracked/dirty set | fresh `git status` equivalent | clean/dirty carried across time | MEDIUM-HIGH |
| Running / background processes | background ACK text (by design excluded from verification identity); timeout/signal markers for foreground kills | whether a background job finished, its exit, its effects | process liveness/exit query | that an acknowledged background job succeeded | MEDIUM (task-dependent) |
| External services / APIs | request/response traces that were captured | service-side state changes; uncaptured interactions | fresh service queries where relevant | idempotence/side-effect freedom without evidence | TASK-DEPENDENT, potentially HIGH |
| Post-TOOL_OUTCOME_UNKNOWN side effects | THAT outcome is unknown (durable synthetic record); nothing about effect occurrence | whether the interrupted execution mutated anything | external/state inspection before relying either way | BOTH "it failed" AND "it succeeded" (repair guidance says exactly this) | HIGH — any completion claim touching the interrupted op's target |
| Unknown-outcome MUTATION (write/edit crashed mid-flight) | durable tool/call; synthetic isError=true; Orcana sees NEITHER success NOR ambiguity (mutation=false, gen frozen — experiment H) | whether workspace changed | workspace inspection | generation==0 ⇒ workspace pristine | HIGH — stale PASS resurrection scenario (A/H) |
| Verification evidence after later mutation | the pass receipt @old-generation (durable); internal staleness flag vs rebuilt generation | whether the evidence still holds NOW | re-run verification or inspect artifacts | old PASS = current truth when internal generation failed to advance (A/E/H paths) | HIGH — rule-1/rule-3 inputs |
| Workspace changes while Orcana down | nothing (no observations occurred) | everything that changed downtime | full re-orientation per task needs | continuity of generation/receipts as world description | HIGH at cold resume |
| Actual world freshness of ANY historical verification | the historical result only | present-tense validity | fresh observation | "PASS then ⇒ PASS now" | HIGH generally |

Cross-cutting statement (Rule 3/8 applied): every freshness assertion Orcana
can make is GENERATION-relative (internal, deterministic, rebuildable) —
world-freshness additionally requires observation whose NEED is created by
the generation gaps documented above (bash-class mutations, nested code-mode
mutations, unknown-outcome mutations, downtime drift).

## D. Reset-Safety Assessment

States currently NOT fully preserved across restart. For each: semantic
safety, false-completion risk, efficiency-only?, autonomy concern, evidence
status.

| State | Current restart behavior | Semantically safe? | Could reset create FALSE COMPLETION? | Efficiency / repetition / steering only? | Preserving it could reduce model autonomy? | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| TurnState | POLLUTED aggregate (not a clean reset): sticky historical flags judged in first settle; history-armed reminder fires on first live call (proven) | Current pollution: no false-completion path found (guard/ladder outputs steer messages only; nothing blocks stopping); distortion is behavioral | No such path identified | Yes — mis-timed/mis-targeted steering | The mis-fired historical reminder is model-visible noise about pre-crash calls — mild autonomy/attention cost | Behavior-quality defect CONFIRMED; preservation value AMBIGUOUS / UNRESOLVED |
| Zero-progress chain | resets to 0 | Yes (ladder output = steering only) | No path found (chain never gates guard or stop) | Yes — escalation delayed by up to threshold rounds | More repeated rounds before strong steer — mild | Safe-but-lossy; preservation value AMBIGUOUS; would REQUIRE round-boundary reconstruction that replay lacks today |
| Forced-continuation budget | deleted (:403) | Yes for truth; NOTE budget also suppresses COMPLETION-GUARD steering at exhaustion (:518) — reset RESTORES guard availability | No (nothing blocks stop regardless; guard only countersteers) | Mostly; guard-availability side is arguably correctness-positive | Preserving pre-crash count would silence the guard SOONER after resume — potential autonomy/oversight reduction | Reset currently leans SAFER for oversight; preservation value AMBIGUOUS / UNRESOLVED |
| Ring / fingerprint optimization | rebuilt with shifts (D6 double-count, hash drift) | Yes | No | Repeat-detection quality only | no | Efficient-lossy; fine |
| Turn-local accumulators (inline streak/counters) | inside TurnState pollution | as TurnState | no | yes | no | AMBIGUOUS preservation value |
| Router / process-local installs | re-applied from config (VERIFIED) | Yes | No | none | no | No issue |
| engines registry | swapped | Yes | No | none | no | No issue |

Net application of Rule 7: none of these resets was found to manufacture
false truth; they degrade steering timeliness/quality. Therefore NONE is
hereby promoted to a correctness-critical persistence need. Rule 8: where
truth is the issue (generation/freshness/unknown-effects), the gap is
classified as a WORLD-OBSERVATION requirement, not a persistence proposal.

## E. Projection-Loss Assessment

Four-way distinction applied to each seam fact:

| Fact | Durable? | Orcana projection outcome | Category | Evidence |
| --- | --- | --- | --- | --- |
| TOOL_NOT_STARTED (synthetic result, no durable call) | yes (A) | DROPPED ENTIRELY — no pending call ⇒ orphan-skip ⇒ 0 EngineEvents; request-side block also unconsumed | durable fact exists → projection drops it | repair.ts:118–119; translateSessionEvents orphan path; Correction A |
| TOOL_OUTCOME_UNKNOWN | yes (A) | WEAKENED — EngineEvent exists (pairs via synthetic result) but structured code/name lost; shell-verification status degrades UNKNOWN→FAIL (G) | durable fact exists → projection weakens it | src :243–256, 296–300; receiptStatus; experiment G |
| Surface replacement (+surfaceOp/sourceEventSeqs/prune event) | yes (A) | DISTORTED — metadata dropped; replacement replays as a SECOND full observation; mutation replacements double generation (I/J); indistinguishable from accidental duplicates | durable fact exists → projection distorts it | D5/D6/D7; experiments I/J |
| Code-mode nested effects | yes (A — code-dispatch records carry name/isError/content) | DROPPED from replay (sessionReplayEvents filter); live saw them | durable fact exists → projection drops it (replay side) | D1/D2; CodeDispatchLog types :239–252 |
| final-result pipeline failures | yes (A) | INVERSE ASYMMETRY — present in replay, ABSENT live (bypass post-execute) | durable fact exists → LIVE view lacks it | dsh-tools :301–303, 3002 |
| Tool nesting identity (rootCallId/subCallId/parent) | yes (A) | DROPPED — EngineEvent carries callId only; no nesting dimension | durable fact exists → projection drops it | ToolExecutionInput :196–211; EngineEvent :44–79 |
| Verification receipt identity/status (root bash, unreplaced, markered) | yes (A input) | PRESERVED — deterministic rebuild equals live fold for this domain (fixture-pinned) | durable fact exists → projection preserves it | adapter.spec.ts:105–143 |
| Verification status for synthetic-unknown | yes (A) | WEAKENED — FAIL substituted for UNKNOWN | durable fact exists → projection weakens it | experiment G |
| Verification receipt under surface replacement | yes (A, two records) | DISTORTED — overwritten by whichever copy replays last | durable fact exists → projection distorts it | D6 |
| World-truth of any of the above | NEVER durable (E) | not representable from history at all | durable fact does not exist → must remain unknown / require world observation | World-Drift Matrix |

## F. Open Questions

Inherited unknowns (kept open, classified):

| Unknown | Kind | Blocks this classification? | Disposition |
| --- | --- | --- | --- |
| 1. checkpoint-policy flush timing relative to post-execute | DURABILITY-BOUND unknown (crash-tail size) | No — matrix rows hold for all surviving-history cases; bounds only the crash-moment edge | Defer to R0-C (crash boundary) |
| 2. background eventual-result lifecycle | SEMANTIC unknown (does a later observable result exist?) | Partially — background row stays E/F hybrid | Later investigation; do not guess |
| 3. downstream post-execute replacement/block frequency | DEPLOYMENT-MEASUREMENT unknown | No — D3 stays conditional either way | Measure in deployed telemetry, later |
| 4. accidental physical duplicate frequency | DATA-Quality unknown | No — D7 mechanism classification independent of frequency | Sample real logs, later |
| 5. deployed version vs lockfile rc.6 | ENVIRONMENT consistency unknown | No — all claims tagged rc.6-verified | Release/deployment discipline decision, later |

New unresolved raised by this matrix (honestly retained):

| Question | Why open | Suggested owner phase |
| --- | --- | --- |
| Does preserving chain/budget/TurnState improve governance enough to matter? | no correctness evidence; policy-dependent | R0-C/D evidence gathering |
| Do code-dispatch records suffice for faithful NESTED VERIFICATION receipts (not just mutation facts)? | content present in type; end-to-end fidelity unverified | later seam audit |
| Should "cleanliness" of first post-resume round be defined via replayed boundaries? | requires boundary-emission semantics decision outside R0-B | R0-C/D |

No Open Question was closed by assumption.

## Evidence Index (this revision's fresh verification)

| Claim class | Command / location | Result |
| --- | --- | --- |
| governor-core unit suite | `cd /home/fuqiang/orcana-dsh/packages/governor-core && npx vitest run tests/core.spec.ts tests/p2.spec.ts tests/p3.spec.ts tests/p4.spec.ts` | 4 files / 72 tests PASS (exit 0) |
| dsh-governor targeted suite | `cd …/packages/dsh-governor && npx vitest run tests/adapter.spec.ts tests/p2-policy.spec.ts tests/p4-policy.spec.ts tests/p5-policy.spec.ts` | 4 files / 30 tests PASS (exit 0) |
| Seams identical to audited R0-A state | `git diff --stat 215595e -- packages/ benchmark/` (empty); `cmp` byte-compare of 5 key files vs independent checkout | IDENTICAL |
| G/H/I/J (unknown→FAIL; frozen-gen; replacement×2; gen doubling) | `node --experimental-strip-types /tmp/r0a-rev3.mts` | reproduced identically |
| A/B/D/E (stale-PASS resurrection; polluted settle + armed reminder; duplicate gen×2; sed-i invisibility) | `/tmp/r0a-experiment.mts`, `/tmp/r0a-experiment2.mts` | reproduced identically |
| Repair codes/constants | harness monorepo @15148dbd9a packages/core/session/src/repair.ts:13–16,27 | confirmed in place |
| CodeDispatchLog richness (name/isError/content/subCallId) | installed dsh-tools types index.d.ts:239–252 | confirmed |

All R0-A citations reused here remain valid because seams are unchanged
since the accepted audit commit; conflicts between R0-A text and source:
none found this pass (two minor R0-A wording issues flagged by audit are
intentionally left untouched per task hygiene rules and do not contaminate
this artifact).

## Scope Statement

Docs-only. No production code, tests, configs, benchmark, or R0-A document
modified. No recovery implementation, persistence, checkpoint, dedupe,
boundary-emission, or steering design proposed anywhere above; gaps are
named as projection/world-observation facts and left to later phases.
