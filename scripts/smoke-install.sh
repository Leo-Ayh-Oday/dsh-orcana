#!/usr/bin/env bash
# P0 smoke: build, create an isolated bench home, boot the bench profile with
# the control and treatment patches, and assert the governor mounts (and
# disposes) cleanly. Local-file install path is exercised by make-bench-home.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_REPO="${DSH_REPO:-$HOME/deepseek-harness}"
if [ ! -d "$DSH_REPO" ]; then
  echo "set DSH_REPO to the deepseek-harness checkout" >&2
  exit 2
fi

echo "== build orcana packages =="
(cd "$REPO_ROOT" && pnpm -r build)

echo "== fresh bench home (local-file install path) =="
"$REPO_ROOT/scripts/make-bench-home.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$REPO_ROOT/benchmark/bench-home-template/." "$TMP/home/"

run_arm() {
  local label="$1" patch="$2" expect_row="$3"
  local log="$TMP/$label.log" tree="$TMP/$label.tree.yml"
  echo "== boot [$label] =="
  set +e
  (cd "$DSH_REPO" && DSH_HOME="$TMP/home" pnpm dsh --profile bench --patch "$patch" --help) > "$log" 2>&1
  local code=$?
  set -e
  # Row presence is proven by the boot-free config dump; activation by a
  # clean boot (the Loader fails loud when any entry cannot activate).
  (cd "$DSH_REPO" && DSH_HOME="$TMP/home" pnpm dsh --dump-config --profile bench --patch "$patch") > "$tree" 2>/dev/null
  local rows
  rows=$(grep -c "name: '@orcana/dsh-governor'" "$tree" || true)
  if [ "$expect_row" = present ] && [ "$rows" -ge 1 ]; then
    echo "PASS: $label row present in composed tree"
  elif [ "$expect_row" = absent ] && [ "$rows" -eq 0 ]; then
    echo "PASS: $label row absent from composed tree"
  else
    echo "FAIL: $label row count expected $expect_row got $rows"; exit 1
  fi
  if [ "$code" -eq 0 ]; then
    echo "PASS: $label boot clean (exit 0)"
  else
    echo "FAIL: $label boot exit $code"; tail -20 "$log" >&2; exit 1
  fi
}

run_arm control "$REPO_ROOT/benchmark/patches/control.patch.yml" absent
run_arm treatment "$REPO_ROOT/benchmark/patches/treatment.patch.yml" present

echo "== packed (tarball) install path =="
PACKED="$TMP/packed"
mkdir -p "$PACKED/home/profiles/bench"
(cd "$REPO_ROOT/packages/governor-core" && pnpm pack --pack-destination "$PACKED" >/dev/null)
(cd "$REPO_ROOT/packages/dsh-governor" && pnpm pack --pack-destination "$PACKED" >/dev/null)
CORE_TGZ=$(ls "$PACKED"/*governor-core*.tgz | head -1)
GOV_TGZ=$(ls "$PACKED"/*dsh-governor*.tgz | head -1)
cat > "$PACKED/home/profiles/bench/package.json" <<JSON
{
  "name": "dsh-profile-bench",
  "private": true,
  "dependencies": {
    "@orcana/governor-core": "file:$CORE_TGZ",
    "@orcana/dsh-governor": "file:$GOV_TGZ"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } }
}
JSON
cat > "$PACKED/home/profiles/bench/pnpm-workspace.yaml" <<YAML
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

overrides:
  '@orcana/governor-core': file:$CORE_TGZ
  '@orcana/dsh-governor': file:$GOV_TGZ
YAML
echo "[]" > "$PACKED/home/profiles/bench/cordis.patch.yml"
(cd "$PACKED/home/profiles/bench" && pnpm install >/dev/null 2>&1)
set +e
(cd "$DSH_REPO" && DSH_HOME="$PACKED/home" pnpm dsh --profile bench --patch "$REPO_ROOT/benchmark/patches/treatment.patch.yml" --help) > "$TMP/packed.log" 2>&1
PACKED_CODE=$?
set -e
if [ "$PACKED_CODE" -eq 0 ]; then echo "PASS: packed install boots treatment (exit 0)"; else echo "FAIL: packed boot exit $PACKED_CODE"; tail -20 "$TMP/packed.log" >&2; exit 1; fi

echo "== dev-install.sh into a temp home =="
TMPDEV="$(mktemp -d)"
DSH_HOME="$TMPDEV" bash "$REPO_ROOT/scripts/dev-install.sh" > "$TMP/dev-install.log" 2>&1
if [ ! -d "$TMPDEV/profiles/orcana/node_modules/@orcana/dsh-governor" ]; then
  echo "FAIL: orcana profile packages not installed"; tail -20 "$TMP/dev-install.log" >&2; exit 1
fi
echo "PASS: dev-install installed packages into orcana profile"
# base-only profile has no runner/help exit path; verify composition instead of booting
(cd "$DSH_REPO" && DSH_HOME="$TMPDEV" pnpm dsh --dump-config --profile orcana) > "$TMP/orcana.tree.yml" 2>/dev/null
if grep -q "name: '@orcana/dsh-governor'" "$TMP/orcana.tree.yml"; then
  echo "PASS: orcana profile composes the governor row"
else
  echo "FAIL: orcana profile tree lacks the governor row"; exit 1
fi

echo "SMOKE OK"