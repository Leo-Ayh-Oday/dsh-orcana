# @leooday/dsh-governor

[English](README.md) | [中文](README.zh.md)

DSH adapter plugin for the Orcana runtime pack: mounts the framework-agnostic
`ProgressFactEngine` on DSH extension points. Function plugin
(name / Config / apply, no default export).

## Extension points

| Concern | Hook |
|---|---|
| Observe every tool call | `tools/post-execute` (waterfall, always `next()`) |
| In-round repeat reminders | `PostToolDecision.additionalContexts` (auto-logged as `user/message`, once per round) |
| Zero-progress escalation + forced continuation | `agent/turn-stopping` + `agent.steer()`, bounded by maxForcedContinuations |
| User interjection reset | `agent/pre-step` (user-source messages reset chains and the budget) |
| Verification-state snapshot | `systemPrompt.context` (durable user-role snapshot, `orcana:verification-state`, order 250) |

## Translation contract

`toEngineEvent` is the single DSH→core translation used by both the live
listener and `translateSessionEvents` (session-log replay): normalized
command, exit-code marker recovery, background-ack exclusion, mutation flag.
Replaying a session log through `ProgressFactEngine.rebuild` reproduces the
live engine state — covered by tests.

## Config

governor.enabled / mode (observe | warn-steer | enforce) / zeroProgressThresholds /
fingerprintWindow / inlineRepeatTools (default read/bash/*search*, aligned with
the coordinated repeat-tool-reminder exclude); evidence.enabled / freshness /
verifyCommandPatterns;
completion.mode / maxForcedContinuations; tools.disclosure / defaultProfile.
Every field validated by schemastery with defaults; the benchmark treatment
patch overrides them via `!!js process.env.ORCANA_*` ablation knobs.

## Known Limitations

- Bash non-zero exits are reported in the result text, not as `isError`
  (the exit-marker contract); receipts parse the marker.
- Background bash acknowledgements carry no terminal exit status and are
  excluded from verification.
- Mutations inside shell commands are invisible to the generation counter
  (v0.2: git-probe receipts).
- The verification snapshot renders only commands that produced receipts
  (matched by verifyCommandPatterns); NONE placeholders are future work.
- Compaction-pruned logs replay to the pruned state (authoritative).