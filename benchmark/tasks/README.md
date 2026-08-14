# Task pool

Candidate repositories and issue-derived tasks. **Names here are a search
pool, not the benchmark specification** — a task enters `manifests/` only
after passing Gates A/B/C and the dry-run calibration.

Selection protocol (every task must pass all):

1. Authoritative, active repo with a clear issue → merged PR path; ground truth = fix commit.
2. Clone ≤ ~100 MB; install + targeted tests ≤ ~5 min (measured).
3. Deterministic tests: no network at test time, no flaky suites, pinned runtime.
4. Self-contained issue text; no human clarification, no API keys.
5. Fix shape matches its group (local / cross-file / investigation / verification trap); no docs/config/dependency-only diffs.
6. Baseline suite green at base (Gate A); hidden reproducer red at base (Gate B); official fix green on both (Gate C).

Candidate pool (JS/TS first for fast builds):

| Group | Candidates |
|---|---|
| A. local bug | marked, dayjs, zod |
| B. cross-file bug | fastify, axios, execa |
| C. investigation-heavy | eslint / vitest deep paths, httpx |
| D. verification trap | PRs whose review took multiple rounds and whose fix diff clearly exceeds the naive fix; repos with slow/incomplete default suites |
