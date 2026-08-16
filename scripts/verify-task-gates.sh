#!/usr/bin/env bash
# Verify a task's three gates (PLAN 5.5) and record the result.
#
# Usage: verify-task-gates.sh <task-dir>
#   <task-dir>  e.g. benchmark/tasks/demo — must contain `repo/` (the base
#               workspace) and may contain `gates/fix/` (official fix files,
#               mirrored to repo-relative paths).
#
# Gate A: baseline_command must pass on the base.
# Gate B: reproducer must FAIL on the base.
# Gate C: with the official fix applied, baseline_command AND reproducer pass.
#
# Runs on a temporary copy; writes <task-dir>/gates/<name>-gates.json.
set -euo pipefail

TASK_DIR="${1:?usage: verify-task-gates.sh <task-dir>}"
REPO="$TASK_DIR/repo"
FIX_DIR="$TASK_DIR/gates/fix"
NAME="$(basename "$TASK_DIR")"
OUT="$TASK_DIR/gates/$NAME-gates.json"

command -v jq >/dev/null || { echo "error: jq required" >&2; exit 1; }
[ -d "$REPO" ] || { echo "error: $REPO missing" >&2; exit 1; }

# The verification commands come from the frozen manifest.
MANIFEST="${2:-$(cd "$(dirname "$TASK_DIR")/.." && pwd)/manifests/$NAME.json}"
if [ -f "$MANIFEST" ]; then
  BASELINE="$(jq -r '.verification.baseline_command' "$MANIFEST")"
  REPRODUCER="$(jq -r '.verification.reproducer' "$MANIFEST")"
  ACCEPTANCE="$(jq -r '.verification.acceptance' "$MANIFEST")"
else
  echo "warning: no manifest at $MANIFEST; using defaults" >&2
  BASELINE="npm test"
  REPRODUCER="node reproducer.js"
  ACCEPTANCE="npm test && node reproducer.js"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -a "$REPO/." "$WORK/"

run_cmd() { # name, expect-pass, command...
  local name="$1" expect="$2"
  shift 2
  if bash -c "$*" >/dev/null 2>&1; then
    [ "$expect" = pass ] && { echo "PASS $name"; return 0; }
    echo "FAIL(gate violated) $name: expected to fail but passed"; return 1
  else
    [ "$expect" = fail ] && { echo "PASS $name (as expected: failed)"; return 0; }
    echo "FAIL $name"; return 1
  fi
}

pushd "$WORK" >/dev/null
GATE_A=false; GATE_B=false; GATE_C_AB=false; GATE_C_RB=false; GATE_C_AC=false
run_cmd "Gate A ($BASELINE)" pass "$BASELINE" && GATE_A=true
run_cmd "Gate B ($REPRODUCER)" fail "$REPRODUCER" && GATE_B=true
if [ -d "$FIX_DIR" ]; then
  while IFS= read -r fix; do
    rel="${fix#"$FIX_DIR"/}"
    mkdir -p "$(dirname "$rel")"
    cp "$fix" "$rel"
  done < <(find "$FIX_DIR" -type f)
fi
run_cmd "Gate C baseline ($BASELINE)" pass "$BASELINE" && GATE_C_AB=true
run_cmd "Gate C reproducer ($REPRODUCER)" pass "$REPRODUCER" && GATE_C_RB=true
run_cmd "Gate C acceptance ($ACCEPTANCE)" pass "$ACCEPTANCE" && GATE_C_AC=true
popd >/dev/null

mkdir -p "$(dirname "$OUT")"
jq -n \
  --arg task "$NAME" \
  --argjson baseline "$GATE_A" \
  --argjson reproducer "$GATE_B" \
  --argjson fix_baseline "$GATE_C_AB" \
  --argjson fix_reproducer "$GATE_C_RB" \
  --argjson fix_acceptance "$GATE_C_AC" \
  '{task: $task, verified_at: (now | todate), gates: {baseline: {existing_suite: $baseline}, reproducer: {base: $reproducer}, official_fix: {existing_suite: $fix_baseline, reproducer: $fix_reproducer, acceptance: $fix_acceptance}}}' \
  > "$OUT"
echo "gates recorded at $OUT"
[ "$GATE_A" = true ] && [ "$GATE_B" = true ] && [ "$GATE_C_AB" = true ] && [ "$GATE_C_RB" = true ] && [ "$GATE_C_AC" = true ]
