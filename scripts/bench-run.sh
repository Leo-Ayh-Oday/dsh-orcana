#!/usr/bin/env bash
# bench-run.sh — run the benchmark supervisor with OS-level network isolation
# (PLAN 5.6 layer 2: no default route in the run's namespace; the tool-level
# web ban lives in the shared bench profile patch).
#
# The isolated namespace has NO outbound route at all — including to the
# model API. For a live A/B run the deployment must provide a reachable
# model endpoint inside the namespace (e.g. a model proxy bound there) via
# the run's DSH provider config; without one, expect MISSING_CREDENTIAL or
# provider-connect failures. Use --no-netns only for local diagnostics.
#
# usage: bench-run.sh [--no-netns] [--] <supervisor args...>
#   e.g. bench-run.sh --live --manifests benchmark/manifests --max-calls 3
set -euo pipefail

NETNS=1
if [ "${1:-}" = "--no-netns" ]; then
  NETNS=0
  shift
fi

NODE_BIN="${NODE_BIN:-node}"
SUPERVISOR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/benchmark/runner/supervisor.mjs"

if [ "$NETNS" = "1" ]; then
  if unshare -r -n true 2>/dev/null; then
    exec unshare -r -n "$NODE_BIN" "$SUPERVISOR" "$@"
  fi
  if unshare -n true 2>/dev/null; then
    exec unshare -n "$NODE_BIN" "$SUPERVISOR" "$@"
  fi
  echo "error: no usable network-namespace isolation (unshare -n / -r -n failed)." >&2
  echo "       Use --no-netns only for local diagnostics; live runs need isolation." >&2
  exit 1
fi

exec "$NODE_BIN" "$SUPERVISOR" "$@"
