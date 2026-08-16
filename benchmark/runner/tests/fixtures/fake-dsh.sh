#!/usr/bin/env bash
# Fake dsh for supervisor live tests: writes FAKE_CALLS assistant messages
# into $DSH_HOME (zstd session log), optionally sleeps, and exits FAKE_EXIT.
# Optional TERM-ignoring for the SIGKILL path test.
set -euo pipefail
NS="--fake-ws--"
SID="session-fake"
mkdir -p "$DSH_HOME/sessions/$NS/$SID"
LOG="$DSH_HOME/sessions/$NS/$SID/session.jsonl"
: > "$LOG"
for ((i = 0; i < FAKE_CALLS; i += 1)); do
  printf '{"type":"assistant/message","time":%s,"data":{"usage":{"inputTokens":1}}}\n' "$(date +%s%3N)" >> "$LOG"
done
zstd -q -f "$LOG" -o "$LOG.zstd"
if [ "${FAKE_IGNORE_TERM:-0}" = "1" ]; then trap '' TERM; fi
if [ -n "${FAKE_SLEEP:-}" ]; then sleep "$FAKE_SLEEP"; fi
exit "${FAKE_EXIT:-0}"
