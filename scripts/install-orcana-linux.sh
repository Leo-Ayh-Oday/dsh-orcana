#!/usr/bin/env bash
# Install the locally built dsh-orcana-linux plugin into the user's
# `orcana-linux` profile for interactive development:
#   dsh --profile orcana-linux "<task>".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROF="$DSH_HOME/profiles/orcana-linux"
mkdir -p "$PROF"

if [ ! -f "$PROF/package.json" ]; then
  cat > "$PROF/package.json" <<JSON
{
  "name": "dsh-profile-orcana-linux",
  "private": true,
  "dependencies": {
    "@orcana/dsh-orcana-linux": "file:$REPO_ROOT/packages/dsh-orcana-linux"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
JSON
fi
# Always refresh: the profile patch is generated from the bundle, and a
# stale copy silently ships old hardening during development.
cp "$REPO_ROOT/packages/dsh-orcana-linux-bundle/cordis.patch.yml" "$PROF/cordis.patch.yml"
if [ ! -f "$PROF/pnpm-workspace.yaml" ]; then
  cat > "$PROF/pnpm-workspace.yaml" <<YAML
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

overrides:
  '@orcana/dsh-orcana-linux': file:$REPO_ROOT/packages/dsh-orcana-linux
YAML
fi

(cd "$REPO_ROOT" && pnpm --filter @orcana/dsh-orcana-linux build)
(cd "$PROF" && pnpm install)
echo "installed into $PROF — run: DSH_HOME=$DSH_HOME dsh --profile orcana-linux \"<task>\""

