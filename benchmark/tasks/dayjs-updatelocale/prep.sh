#!/usr/bin/env bash
# prep.sh — build the dayjs-updatelocale task workspace (PLAN 5.5/5.6 prep).
# Clone → checkout base (the fix commit's parent) → install → build the
# artifacts → strip .git. The run workspace is staged from here per run.
set -euo pipefail

TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$TASK_DIR/repo"
BASE_SHA="99691c5f3bd1371d3b763d5f9dfaed9a1945a477^"

rm -rf "$REPO"
git clone --quiet https://github.com/iamkun/dayjs "$REPO"
(cd "$REPO" \
  && git checkout --quiet "$BASE_SHA" \
  && npm install --quiet \
  && NODE_OPTIONS=--openssl-legacy-provider npm run build >/dev/null \
  && rm -rf .git)

echo "workspace ready at $REPO (base $BASE_SHA)"
