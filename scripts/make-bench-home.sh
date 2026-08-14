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

# Shared coordination for BOTH arms: the governor owns repeat detection for
# read/bash/search in treatment, so the base reminder excludes them here —
# control and treatment patches then differ ONLY in orcana activation.
# Pollution lockdown: dsh-base mounts web_search; the benchmark denies it in
# both arms (network DENY is enforced here at the tool level, plus OS-level
# isolation by the runner — see PLAN 5.6).
cat > "$PROF/cordis.patch.yml" <<YAML
# Shared bench profile coordination (both arms).
- id: repeat-tool-reminder
  config:
    exclude: [read, bash, '*search*']
- id: tool-web
  disabled: true
YAML

(cd "$REPO_ROOT" && pnpm -r build)
(cd "$PROF" && pnpm install)

# The dsh installation's flat module fallback is healed at boot; nothing to do here.
echo "bench-home-template ready at $TEMPLATE"