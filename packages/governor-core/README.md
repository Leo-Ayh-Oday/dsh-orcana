# @orcana/governor-core

[English](README.md) | [中文](README.zh.md)

Framework-agnostic progress-fact engine (zero Cordis, zero DSH). The pure core
of the Orcana runtime pack: classifies tool observations into progress signals,
tracks the workspace generation, and records verification receipts.

## API

- `canonicalizeArgs` / `sha256` — fingerprint building blocks.
- `classifyObservation` — ring-based classification: within the current
  generation, an exact (tool, args, hash) match anywhere in the window is a
  repeated observation (alternating repeats like A-B-A are caught); the same
  call with a new result is new evidence; anything else is progress.
- `verificationToken` / `matchesVerificationPattern` / `isVerificationCommand`
  — first-verb verification recognition (`npm test` → `test`; a
  `grep -r test src` never matches).
- `receiptStatus` — interruption > exit marker > isError > clean-pass.
- `ProgressFactEngine` — one state machine with a SINGLE transition path:
  `applyEvent(EngineEvent)` is used by both the live adapter and the
  session-log replay (`rebuild`), so the two cannot drift. `snapshot` /
  `restore` carry durable state.

## Invariants

- Live state and resumed state are built by the same code path.
- The engine never decides what the model sees; it only derives facts.
- Receipts are keyed by the normalized command identity (never the
  description-bearing full arguments).

## Known Limitations

- The shell exit-marker contract (`[exit code: N]` etc.) is owned by
  `@deepseek-ai/dsh-shell`; the adapter parses it. If the format changes,
  receipts degrade to clean-pass readings (only suppresses pass/fail steers).
- Replay reflects the CURRENT session log; compaction pruning may rewrite
  result content, so replay state is authoritative over a divergent live tail.
