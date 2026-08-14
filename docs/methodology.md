# Methodology

Frozen benchmark invariants (from the v2 review; see PLAN-v0.1.md §5 and §10).

1. **A/B isomorphism** — same profile, same dependency tree, same installed
   Orcana package; the only independent variable is activation
   (control.patch vs treatment.patch).
2. **Isolation** — every run gets a fresh `DSH_HOME` copied from
   `benchmark/bench-home-template`; user profile/home patches never reach a run.
3. **Authoritative timeout** — the supervisor owns the verdict:
   `INCOMPLETE_TIMEOUT` → SIGTERM → 5 s grace → SIGKILL. DSH's exit code is
   never read as success.
4. **Durability semantics** — semantic checkpoints (before model requests,
   before top-level tool side effects, at `agent/pre-step`); the last
   in-flight streaming batch may be lost; unfinished external side effects are
   unknown outcome.
5. **Three gates** — baseline existing suite green (A), hidden reproducer red
   at base (B), official fix green on both (C); verified separately and pinned
   in the manifest.
6. **Budgets** — 40 LLM calls primary, 30 min wall, cost ceiling fuse, fixed
   max_output_tokens/effort/sampling. Exhaustion = `incomplete`, never `fail`.
7. **Pairing** — per task, randomized arm order, pairs run consecutively;
   statistical unit is (task, arm); report paired deltas.
8. **Pins** — DSH npm version + git SHA, Orcana SHA, Node, pnpm, OS/kernel,
   model id, profile config digest, task manifest digest, run timestamps.
9. **Pollution lockdown** — no GitHub/search/arbitrary web from the agent;
   registry allowlist only; benchmark clone has no `origin` and no fix commit
   in local history.
10. **Judging** — an independent script (not the agent, not an LLM) applies the
    manifest's acceptance command to the resulting workspace; false completion
    = agent claimed done but acceptance failed.
11. **Environment pin** — DSH_PERMISSION_MODE=danger-full-access (approval
    never; headless 'ask' fails closed with no answerer), telemetry off, tools
    mode unset, cwd = task workspace; web_search disabled in BOTH arms
    (shared profile patch); run-time outbound network denied (deps
    preinstalled); all values identical across arms and recorded per run.