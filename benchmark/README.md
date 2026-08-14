# Benchmark

A/B harness for the Orcana runtime pack. **Same model. Same DSH. One runtime
intervention.** See [docs/methodology.md](../docs/methodology.md) for the
frozen invariants.

## Layout

| Path | Role |
|---|---|
| `tasks/` | Candidate task pool + dry-run results (Gates A/B/C) |
| `manifests/` | Frozen, content-addressed task manifests |
| `patches/` | control.patch.yml (off) / treatment.patch.yml (on) |
| `runner/` | Supervisor: budgets, pairing, isolated homes, authoritative status |
| `reports/` | Per-run logs and paired reports |

## Arms

```sh
# A (control): orcana installed, not activated
DSH_HOME=<run-home> dsh --profile bench --patch patches/control.patch.yml "<task>"
# B (treatment): orcana activated
DSH_HOME=<run-home> dsh --profile bench --patch patches/treatment.patch.yml "<task>"
```

## Hard invariants (frozen)

1. A/B share the same profile, dependency tree, and installed Orcana package — only activation differs.
2. Isolated `DSH_HOME` per run (template copy/reflink); no user profile/home patches.
3. Timeout verdict belongs to the supervisor, never to DSH's exit code.
4. Durability = semantic-checkpoint durability; the last in-flight streaming batch may be lost; unfinished external side effects are unknown-outcome.
5. Gates A/B/C verified separately and pinned: existing suite green, reproducer red, official fix green.
