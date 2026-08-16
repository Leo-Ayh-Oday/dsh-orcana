# Benchmark

A/B harness for the Orcana runtime pack. **Same model. Same DSH. One runtime
intervention.** See [docs/methodology.md](../docs/methodology.md) for the
frozen invariants and their implementation status.

## Layout

| Path | Role |
|---|---|
| `tasks/` | Candidate task pool: `demo/` is the synthetic verification-trap task with its three gates recorded |
| `manifests/` | Frozen, content-addressed task manifests (JSON, §5.7 contract) |
| `patches/` | control.patch.yml (off) / treatment.patch.yml (on) — the only arm difference |
| `runner/` | Supervisor (budgets, pairing, isolated homes, authoritative verdicts), metrics aggregation, independent judge |
| `reports/` | Per-run records (`run-*.json`) and paired reports (`paired-*.json`) |

## Running

```sh
# Dry-run: print the paired plan (task × arms, deterministic seed) — nothing executes
node benchmark/runner/supervisor.mjs --manifests benchmark/manifests

# Live with OS-level network isolation (PLAN 5.6 layer 2): no default route
# in the run's namespace; model endpoint must be reachable inside it.
scripts/bench-run.sh --live --manifests benchmark/manifests

# Live on hosts where the model provider is only reachable through a proxy:
# the run gets an allowlist CONNECT proxy (opencode.ai & co. only; everything
# else the agent tries is 403) chained to the host proxy. Host proxy vars
# never reach the run environment.
UPSTREAM_PROXY=http://127.0.0.1:7890 scripts/bench-run.sh --no-netns --model-proxy -- \
  --live --manifests benchmark/manifests

#   filters: --task <id> --arm <control|treatment> --seed <n> --reps <n>
#   budget overrides: --max-calls <n> --wall-ms <n> --max-tokens <n>

# Offline analysis of the reports (paired deltas + discipline metrics):
node benchmark/runner/analyze.mjs --reports benchmark/reports --sessions benchmark --out benchmark/reports/analysis.json
```

Each live run: isolated `DSH_HOME` (template copy) → agent under budgets →
session metrics (aggregate.mjs) → independent judge (acceptance command +
completion-claim check). Infrastructure failures retry once; result-level
outcomes never retry.

## Task lifecycle

1. Prepare the task workspace (`tasks/<name>/repo/`): base checkout, hidden
   reproducer, official fix under `tasks/<name>/gates/fix/`.
2. Verify the three gates and record them:
   `scripts/verify-task-gates.sh tasks/<name> benchmarks/manifests/<id>.json`
3. Freeze the manifest (`manifests/<id>.json`, §5.7 fields + `workspace`).

## Results (2026-08-16 snapshot)

Paired A/B, deepseek-v4-flash, independent judge. Raw data: `reports/`
(`run-*.json` per run, `paired-*.json` per plan, `analysis-v3.json` full
fold); first runs archived in `reports-v1-archive/`.

| Task | n | Outcome | Treatment − control (tokens) |
|---|---|---|---|
| demo-format-money | 2 | both arms success | −871 / −2695 (both negative) |
| marked-blank-tab | 6 | all arms 24/24 calls (budget-capped) | −4079 / +4082 / −29107 / −12181 / +48428 / −8850 — 4/6 negative, median ≈ −6.5k |
| dayjs-updatelocale | 3 | all arms 20/20 calls (budget-capped) | +2459 / −1841 / −731 — 2/3 negative, median ≈ −0.7k |

Pooled: **8/11 paired runs used fewer tokens on treatment**; median negative
on every task. Call counts are censored by the budgets on the real tasks.
The harness is the durable deliverable; effect size needs more reps and
tasks.

## Hard invariants (frozen)

1. A/B share the same profile, dependency tree, and installed Orcana package — only activation differs.
2. Isolated `DSH_HOME` per run (template copy/reflink); no user profile/home patches.
3. Timeout verdict belongs to the supervisor, never to DSH's exit code.
4. Durability = semantic-checkpoint durability; the last in-flight streaming batch may be lost; unfinished external side effects are unknown-outcome.
5. Gates A/B/C verified separately and pinned (verify-task-gates.sh writes the dated record).
6. Environment pin: permission mode danger-full-access (approval never), telemetry/tools-mode and proxy variables stripped, web_search disabled in both arms, recorded per run; run-time OS-level network denial via scripts/bench-run.sh (no default route in the run's namespace; model endpoint must be reachable inside it).
