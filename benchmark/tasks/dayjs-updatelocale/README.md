# dayjs-updatelocale

Real-repository task: [dayjs#1118] / PR #3012 — `updateLocale` with a partial
nested object (e.g. only `formats.L`) must MERGE into the existing object,
not replace it: keys not mentioned in the update (e.g. `formats.LT`) must
survive. Arrays and non-object values still replace entirely.

The reproducer runs against the built artifacts (`dayjs.min.js` +
`plugin/updateLocale.js`), so the agent must rebuild after editing `src/` —
the acceptance command includes the build (with `--openssl-legacy-provider`;
dayjs's webpack stack uses md4).

## Three gates (verified 2026-08-16, re-runnable via scripts/verify-task-gates.sh)

| Gate | Command | Result |
|---|---|---|
| A (baseline green) | `npx jest --coverage=false` | PASS (770 tests) |
| B (reproducer red at base) | `node reproducer.js` | FAIL (LT lost) |
| C (official fix green) | build + jest + reproducer | PASS |

Dated record: `gates/dayjs-updatelocale-gates.json`. Official fix:
`gates/fix/src/plugin/updateLocale/index.js`.

## Prep

```sh
./prep.sh   # clone → checkout base (fix^) → npm install → build → strip .git
```

## Layout

- `prep.sh` — workspace builder (base checkout, no origin, no fix history)
- `repo/` — generated workspace (gitignored)
- `hidden/reproducer.js` — hidden reproducer (3 assertions, Gate B / judge input)
- `gates/` — dated gate records + official fix
- `../manifests/dayjs-updatelocale.json` — frozen manifest

[dayjs#1118]: https://github.com/iamkun/dayjs/issues/1118
