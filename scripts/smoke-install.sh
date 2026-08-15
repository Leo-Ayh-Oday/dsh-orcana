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
  echo "== real boot [$label] (keyless sentinel) =="
  set +e
  # A REAL task boot, not --help: --help exits before the tree activates, so
  # it cannot prove the row mounts (a bogus row also exits 0 under --help).
  # Keyless boot must get PAST tree load + mount and fail only at the missing
  # key; the Loader fails hard on an unresolvable plugin row, so reaching
  # MISSING_CREDENTIAL proves every composed row loaded and applied.
  (cd "$DSH_REPO" && DSH_HOME="$TMP/home" DEEPSEEK_API_KEY= pnpm dsh --profile bench --patch "$patch" "run the tests") > "$log" 2>&1
  local code=$?
  set -e
  # Row presence is proven by the boot-free config dump.
  (cd "$DSH_REPO" && DSH_HOME="$TMP/home" pnpm dsh --dump-config --profile bench --patch "$patch") > "$tree" 2>/dev/null
  local rows
  rows=$(grep -c "name: '@leooday/dsh-governor'" "$tree" || true)
  if [ "$expect_row" = present ] && [ "$rows" -ge 1 ]; then
    echo "PASS: $label row present in composed tree"
  elif [ "$expect_row" = absent ] && [ "$rows" -eq 0 ]; then
    echo "PASS: $label row absent from composed tree"
  else
    echo "FAIL: $label row count expected $expect_row got $rows"; exit 1
  fi
  if grep -q "MISSING_CREDENTIAL" "$log" && ! grep -q "failed to load" "$log"; then
    echo "PASS: $label tree loads and mounts (reaches MISSING_CREDENTIAL)"
  else
    echo "FAIL: $label boot did not reach the keyless sentinel (exit $code)"; tail -20 "$log" >&2; exit 1
  fi
}

run_arm control "$REPO_ROOT/benchmark/patches/control.patch.yml" absent
run_arm treatment "$REPO_ROOT/benchmark/patches/treatment.patch.yml" present

echo "== negative control: an unresolvable plugin row must fail the tree =="
cat > "$TMP/bogus.yml" <<YAML
- insert:
    - id: bogus
      name: '@totally/bogus-package-xyz'
YAML
set +e
(cd "$DSH_REPO" && DSH_HOME="$TMP/home" DEEPSEEK_API_KEY= pnpm dsh --profile bench --patch "$TMP/bogus.yml" "run the tests") > "$TMP/bogus.log" 2>&1
BOGUS_CODE=$?
set -e
if [ "$BOGUS_CODE" -ne 0 ] && grep -q "failed to load" "$TMP/bogus.log"; then
  echo "PASS: bogus row fails the tree load (the probe has teeth)"
else
  echo "FAIL: bogus row did not fail the load (exit $BOGUS_CODE)"; tail -10 "$TMP/bogus.log" >&2; exit 1
fi

echo "== ablation knob negative control: env must reach schemastery validation =="
set +e
(cd "$DSH_REPO" && DSH_HOME="$TMP/home" DEEPSEEK_API_KEY= ORCANA_MODE=bogus pnpm dsh --profile bench --patch "$REPO_ROOT/benchmark/patches/treatment.patch.yml" "run the tests") > "$TMP/ablate.log" 2>&1
ABLATE_CODE=$?
set -e
if [ "$ABLATE_CODE" -ne 0 ] && grep -q 'expected "observe" | "warn-steer" | "enforce"' "$TMP/ablate.log"; then
  echo "PASS: ORCANA_MODE=bogus fails config validation (ablation knobs are live)"
else
  echo "FAIL: ablation knob not enforced (exit $ABLATE_CODE)"; tail -10 "$TMP/ablate.log" >&2; exit 1
fi

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
    "@leooday/governor-core": "file:$CORE_TGZ",
    "@leooday/dsh-governor": "file:$GOV_TGZ"
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
  '@leooday/governor-core': file:$CORE_TGZ
  '@leooday/dsh-governor': file:$GOV_TGZ
YAML
cat > "$PACKED/home/profiles/bench/cordis.patch.yml" <<'YAML'
# Same shared coordination as the local-file bench home (both arms).
- id: repeat-tool-reminder
  config:
    exclude: [read, bash, '*search*']
YAML
(cd "$PACKED/home/profiles/bench" && pnpm install >/dev/null 2>&1)
set +e
(cd "$DSH_REPO" && DSH_HOME="$PACKED/home" DEEPSEEK_API_KEY= pnpm dsh --profile bench --patch "$REPO_ROOT/benchmark/patches/treatment.patch.yml" "run the tests") > "$TMP/packed.log" 2>&1
PACKED_CODE=$?
set -e
if grep -q "MISSING_CREDENTIAL" "$TMP/packed.log" && ! grep -q "failed to load" "$TMP/packed.log"; then
  echo "PASS: packed install loads and mounts treatment (MISSING_CREDENTIAL sentinel)"
else
  echo "FAIL: packed boot did not reach the keyless sentinel (exit $PACKED_CODE)"; tail -20 "$TMP/packed.log" >&2; exit 1
fi

echo "== dev-install.sh into a temp home =="
TMPDEV="$(mktemp -d)"
DSH_HOME="$TMPDEV" bash "$REPO_ROOT/scripts/dev-install.sh" > "$TMP/dev-install.log" 2>&1
if [ ! -d "$TMPDEV/profiles/orcana/node_modules/@leooday/dsh-governor" ]; then
  echo "FAIL: orcana profile packages not installed"; tail -20 "$TMP/dev-install.log" >&2; exit 1
fi
echo "PASS: dev-install installed packages into orcana profile"
# base-only profile has no runner/help exit path; verify composition instead of booting
(cd "$DSH_REPO" && DSH_HOME="$TMPDEV" pnpm dsh --dump-config --profile orcana) > "$TMP/orcana.tree.yml" 2>/dev/null
if grep -q "name: '@leooday/dsh-governor'" "$TMP/orcana.tree.yml"; then
  echo "PASS: orcana profile composes the governor row"
else
  echo "FAIL: orcana profile tree lacks the governor row"; exit 1
fi

echo "SMOKE OK"