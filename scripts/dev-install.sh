#!/usr/bin/env bash
# Install the locally built Orcana packages into the user's `orcana` profile
# for interactive development: dsh --profile orcana "<task>".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROF="$DSH_HOME/profiles/orcana"
mkdir -p "$PROF"

if [ ! -f "$PROF/package.json" ]; then
  cat > "$PROF/package.json" <<JSON
{
  "name": "dsh-profile-orcana",
  "private": true,
  "dependencies": {
    "@orcana/governor-core": "file:$REPO_ROOT/packages/governor-core",
    "@orcana/dsh-governor": "file:$REPO_ROOT/packages/dsh-governor"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
JSON
fi
if [ ! -f "$PROF/cordis.patch.yml" ]; then
  cp "$REPO_ROOT/packages/dsh-bundle/cordis.patch.yml" "$PROF/cordis.patch.yml"
fi
if [ ! -f "$PROF/pnpm-workspace.yaml" ]; then
  cat > "$PROF/pnpm-workspace.yaml" <<YAML
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

overrides:
  '@orcana/governor-core': file:$REPO_ROOT/packages/governor-core
  '@orcana/dsh-governor': file:$REPO_ROOT/packages/dsh-governor
YAML
fi

(cd "$REPO_ROOT" && pnpm -r build)
(cd "$PROF" && pnpm install)
echo "installed into $PROF — run: DSH_HOME=$DSH_HOME dsh --profile orcana \"<task>\""