#!/usr/bin/env bash
# bench-run.sh — run the benchmark supervisor with outbound-network control
# (PLAN 5.6 layer 2).
#
# Two modes (mutually exclusive):
#   1. --netns (default): user+net namespace with NO default route — the run
#      cannot egress at all, model endpoint included. The deployment must
#      expose a model endpoint inside the namespace. Fails loud when no
#      usable namespace is available.
#   2. --no-netns --model-proxy: injects an allowlist CONNECT proxy
#      (benchmark/runner/model-proxy.mjs) as the run's HTTP(S)_PROXY. The
#      model provider is reachable (chained to the host proxy when the
#      provider is only reachable through one), and everything else the
#      agent tries gets 403. The host proxy itself never reaches the run
#      environment (ENV_STRIP).
#   Plain --no-netns (no proxy) is diagnostics-only.
#
# usage: bench-run.sh [--netns|--no-netns] [--model-proxy|--no-model-proxy] -- <supervisor args...>
#   e.g. bench-run.sh --no-netns --model-proxy -- --live --manifests benchmark/manifests
set -euo pipefail

NETNS=1
MODEL_PROXY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --netns) NETNS=1; shift ;;
    --no-netns) NETNS=0; shift ;;
    --model-proxy) MODEL_PROXY=1; shift ;;
    --no-model-proxy) MODEL_PROXY=0; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done

NODE_BIN="${NODE_BIN:-node}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPERVISOR="$REPO_ROOT/benchmark/runner/supervisor.mjs"

if [ "$NETNS" = "1" ] && [ "$MODEL_PROXY" = "1" ]; then
  echo "error: --netns and --model-proxy are mutually exclusive (the namespace has no route to the proxy)" >&2
  exit 1
fi

if [ "$MODEL_PROXY" = "1" ]; then
  PORT="$((20000 + RANDOM % 10000))"
  UPSTREAM_PROXY="${UPSTREAM_PROXY:-${HTTPS_PROXY:-${HTTP_PROXY:-}}}" \
    PORT="$PORT" "$NODE_BIN" "$REPO_ROOT/benchmark/runner/model-proxy.mjs" >/dev/null 2>&1 &
  PROXY_PID=$!
  trap 'kill "$PROXY_PID" 2>/dev/null' EXIT
  sleep 0.5
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "error: model proxy failed to start" >&2
    exit 1
  fi
  exec "$NODE_BIN" "$SUPERVISOR" --model-proxy "http://127.0.0.1:$PORT" "$@"
fi

if [ "$NETNS" = "1" ]; then
  if unshare -r -n true 2>/dev/null; then
    exec unshare -r -n "$NODE_BIN" "$SUPERVISOR" "$@"
  fi
  if unshare -n true 2>/dev/null; then
    exec unshare -n "$NODE_BIN" "$SUPERVISOR" "$@"
  fi
  echo "error: no usable network-namespace isolation (unshare -n / -r -n failed)." >&2
  echo "       Use --no-netns --model-proxy for an allowlist-proxy run, or --no-netns for diagnostics." >&2
  exit 1
fi

exec "$NODE_BIN" "$SUPERVISOR" "$@"
