# Methodology

Frozen benchmark invariants (from the v2 review; see PLAN-v0.1.md §5 and §10).
Implementation status is annotated per invariant; audit fixes land in
PLAN-v0.1.md §11.10.

1. **A/B isomorphism** — same profile, same dependency tree, same installed
   Orcana package; the only independent variable is activation
   (control.patch vs treatment.patch). [implemented]
2. **Isolation** — every run gets a fresh `DSH_HOME` copied from
   `benchmark/bench-home-template` (reflink, plain-copy fallback); user
   profile/home patches never reach a run. [implemented]
3. **Authoritative timeout** — the supervisor owns the verdict:
   `INCOMPLETE_TIMEOUT` → SIGTERM → 5 s grace → SIGKILL. DSH's exit code is
   never read as success. [implemented]
4. **Durability semantics** — semantic checkpoints (before model requests,
   before top-level tool side effects, at `agent/pre-step`); the last
   in-flight streaming batch may be lost; unfinished external side effects are
   unknown outcome. [implemented]
5. **Three gates** — baseline existing suite green (A), hidden reproducer red
   at base (B), official fix green on both (C); verified separately, pinned in
   the manifest, and re-runnable via `scripts/verify-task-gates.sh` (writes a
   dated gates record). [implemented]
6. **Budgets** — 40 LLM calls primary, 30 min wall, cost ceiling fuse
   (cumulative input+output+cacheRead tokens, `BUDGETS.maxSessionTokens`,
   default off, configurable), fixed max_output_tokens/effort/sampling.
   Exhaustion = `incomplete`, never `fail`. [implemented]
7. **Pairing** — per task, randomized arm order (deterministic seed), pairs
   run consecutively; statistical unit is (task, arm); report paired deltas.
   [implemented]
8. **Pins** — DSH version, Node, OS/kernel, platform/arch, profile config
   digest, task manifest digest, run timestamps are recorded per run
   (`recordRun` + `collectPins`). Model id and the Orcana package SHA are
   recorded by the benchmark operator at P7 report time (not yet wired).
   [partially implemented]
9. **Pollution lockdown** — no GitHub/search/arbitrary web from the agent.
   Tool layer: `tool-web` disabled in the shared bench profile patch
   [implemented]. OS layer: run-time outbound network denial (unshare -n or
   container) is NOT yet wired into the runner — a bench-run.sh wrapper is
   the pending piece before live runs. Registry allowlist and repo
   preprocessing (no `origin`, no fix commit in history) apply at task
   preparation time. [partially implemented]
10. **Judging** — an independent script (not the agent, not an LLM) applies the
    manifest's acceptance command to the resulting workspace; false completion
    = agent claimed done but acceptance failed. [implemented]
11. **Environment pin** — DSH_PERMISSION_MODE=danger-full-access (approval
    never; headless 'ask' fails closed with no answerer), telemetry and tools
    mode are STRIPPED from the inherited environment (default off), cwd = task
    workspace; web_search disabled in BOTH arms (shared profile patch);
    all values identical across arms and recorded per run (`env_pin`).
    [implemented]
