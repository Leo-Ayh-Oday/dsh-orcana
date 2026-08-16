# demo-format-money

Synthetic verification-trap task validating the P6 pipeline end to end
without external dependencies or network.

## Task

`src/format.js` `formatMoney` mis-formats negative amounts: `Math.floor`
toward negative infinity drops the sign (`formatMoney(-1.5)` → `$-2.50`
instead of `-$1.50`). The existing suite only covers positive amounts.

## Three gates (verified 2026-08-16)

| Gate | Command | Result |
|---|---|---|
| A (baseline green) | `npm test` | PASS (2 tests) |
| B (reproducer red at base) | `node reproducer.js` | FAIL (2 cases) |
| C (official fix green) | `npm test && node reproducer.js` | PASS |

Fix shape: handle the sign before flooring (`Math.floor(abs / 100)`).

## Layout

- `repo/` — the task workspace (base = buggy)
- `reproducer.js` — hidden reproducer (Gate B / judge input)
- `../manifests/demo-format-money.json` — frozen manifest (digest pinned)
