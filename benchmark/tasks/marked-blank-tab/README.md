# marked-blank-tab

Real-repository task: [markedjs/marked#4007] — a line of only tabs (or tabs +
spaces) must terminate a paragraph under `gfm: false`. Base joins such lines
into a single paragraph (`_paragraph` regex only treated ` +\n` as blank).

## Three gates (verified 2026-08-16, re-runnable via scripts/verify-task-gates.sh)

| Gate | Command | Result |
|---|---|---|
| A (baseline green) | `npm run build:esbuild && npm run test:specs` | PASS (1749 specs) |
| B (reproducer red at base) | `node reproducer.js` | FAIL (3 cases) |
| C (official fix green) | build + specs + reproducer | PASS |

Dated record: `gates/marked-blank-tab-gates.json`. Official fix (one-line
regex change): `gates/fix/src/rules.ts`.

## Prep

```sh
./prep.sh   # clone → checkout base (fix^) → npm install → build → strip .git
```

The staged run workspace is a per-run copy of `repo/` (reflink); the hidden
reproducer is mirrored in by the supervisor only when the judge would see it.

## Layout

- `prep.sh` — workspace builder (base checkout, no origin, no fix history)
- `repo/` — generated workspace (gitignored)
- `hidden/reproducer.js` — hidden reproducer (3 cases, Gate B / judge input)
- `gates/` — dated gate records + official fix
- `../manifests/marked-blank-tab.json` — frozen manifest

[markedjs/marked#4007]: https://github.com/markedjs/marked/pull/4007
