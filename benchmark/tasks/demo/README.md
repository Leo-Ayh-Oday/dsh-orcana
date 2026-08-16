# demo-format-money

Synthetic verification-trap task validating the P6 pipeline end to end
without external dependencies or network.

## Task

`src/format.js` `formatMoney` mis-formats negative amounts: `Math.floor`
toward negative infinity drops the sign (`formatMoney(-1.5)` → `$-2.50`
instead of `-$1.50`). The existing suite only covers positive amounts.

## Three gates (verified 2026-08-16, re-runnable via scripts/verify-task-gates.sh)

| Gate | Command | Result |
|---|---|---|
| A (baseline green) | `npm test` | PASS (2 tests) |
| B (reproducer red at base) | `node reproducer.js` | FAIL (2 cases) |
| C (official fix green) | `npm test && node reproducer.js` | PASS |

Dated record: `gates/demo-gates.json`. Fix shape: handle the sign before
flooring (`Math.floor(abs / 100)`); official fix in `gates/fix/src/format.js`.

## Layout

- `repo/` — the task workspace (base = buggy); the agent NEVER sees
  `hidden/` — the runner stages a per-run copy and mirrors the hidden
  reproducer into it only when the judge would (PLAN 5.1 Hidden Reproducer)
- `hidden/reproducer.js` — hidden reproducer (Gate B / judge input)
- `gates/` — dated gate records + official fix
- `../manifests/demo-format-money.json` — frozen manifest (digest pinned)
