#!/usr/bin/env bash
# prep.sh — build the marked-blank-tab task workspace (PLAN 5.5/5.6 prep).
# Clone → checkout base (the fix commit's parent) → install → build the lib
# → strip .git (no origin, no fix commit in history). The run workspace is
# staged from this directory by the supervisor.
set -euo pipefail

TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$TASK_DIR/repo"
BASE_SHA="bc2f121456d152fafd7d2cbd2c21b273ca4c6862^"

rm -rf "$REPO"
git clone --quiet https://github.com/markedjs/marked "$REPO"
(cd "$REPO" \
  && git checkout --quiet "$BASE_SHA" \
  && npm install --quiet \
  && npm run build:esbuild >/dev/null \
  && rm -rf .git)

echo "workspace ready at $REPO (base $BASE_SHA)"
