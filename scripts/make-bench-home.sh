#!/usr/bin/env bash
# Create the isolated benchmark home template: DSH_HOME with a `bench` profile
# (base + headless bundles) and the Orcana package pre-installed, so A/B arms
# share one profile/node_modules/lockfile and differ only in activation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${1:-$REPO_ROOT/benchmark/bench-home-template}"
rm -rf "$TEMPLATE"
mkdir -p "$TEMPLATE/profiles/bench"
PROF="$TEMPLATE/profiles/bench"

cat > "$PROF/package.json" <<JSON
{
  "name": "dsh-profile-bench",
  "private": true,
  "dependencies": {
    "@orcana/governor-core": "file:../../../../packages/governor-core",
    "@orcana/dsh-governor": "file:../../../../packages/dsh-governor"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } }
}
JSON

cat > "$PROF/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

overrides:
  '@orcana/governor-core': file:../../../../packages/governor-core
  '@orcana/dsh-governor': file:../../../../packages/dsh-governor
YAML

echo "[]" > "$PROF/cordis.patch.yml"

(cd "$REPO_ROOT" && pnpm -r build)
(cd "$PROF" && pnpm install)

# The dsh installation's flat module fallback is healed at boot; nothing to do here.
echo "bench-home-template ready at $TEMPLATE"