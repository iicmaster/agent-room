#!/usr/bin/env bash
# Launch the REL-3 qualifying soak on the quiet host, under the corrected
# quiet-host contract (Story 6.2; the 2026-10-22 amendment).
#
# WHY A LAUNCH SCRIPT. The first twelve-hour run under the contract was typed
# by hand over ssh, and the contract it was running under turned out to be
# unsatisfiable on this host (F18 in the Epic 6 retro). The next run is
# scripted, so that what it measured and how it was launched are the same
# thing every time, and so that the BASELINE the contract's foreign
# thresholds are relative to is captured by the same observer that measures
# the run.
#
# WHAT IT DOES, IN ORDER:
#   1. measures the host's BASELINE (three samples of the foreign state, before
#      the run exists) -> baseline-telemetry.log;
#   2. launches the soak detached, with its world under the run's own
#      directory (never /tmp — macOS temp cleanup ate a credential during an
#      earlier run) and its stdout in soak.log;
#   3. waits for the server's pid and starts the run's own telemetry sidecar
#      against it -> telemetry.log.
#
# The run itself is untouched: it materializes the candidate, proves its
# identity against the frozen record, and applies the pre-registered gates.
#
# Usage: rel3-soak-launch.sh <repo-dir> <parent-dir> [duration-hours]
set -u

REPO="${1:?usage: rel3-soak-launch.sh <repo-dir> <parent-dir> [duration-hours]}"
PARENT="${2:?usage: rel3-soak-launch.sh <repo-dir> <parent-dir> [duration-hours]}"
HOURS="${3:-12}"

WORLD="$PARENT/.soak-world"
RECORD="$PARENT/launch-record.txt"
TELEMETRY="$REPO/scripts/rel1-soak-telemetry.sh"

if [ ! -r "$TELEMETRY" ]; then
  echo "rel3-soak-launch: $TELEMETRY is missing — the run has no telemetry source" >&2
  exit 2
fi

mkdir -p "$WORLD"
: > "$RECORD"
{
  echo "launched_at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "repo $REPO"
  echo "parent $PARENT"
  echo "duration_hours $HOURS"
  echo "node $(node --version)"
  echo "sqlite $(node -e 'process.stdout.write(String(require("node:sqlite").DatabaseSync ? "node:sqlite" : ""))' 2>/dev/null || echo '?')"
} >> "$RECORD"

# --- 1. the baseline ------------------------------------------------------------------------
# Three samples, one a minute apart, of the host's foreign state BEFORE the
# run exists. The contract's foreign-process threshold is relative to this
# number, so it is measured by the same observer that will measure the run.
BASE_LOG="$PARENT/baseline-telemetry.log"
: > "$BASE_LOG"
bash "$TELEMETRY" "$BASE_LOG" 0 "$WORLD" &
BASE_PID=$!
sleep 190
kill "$BASE_PID" 2>/dev/null
wait "$BASE_PID" 2>/dev/null
BASE_SAMPLES=$(wc -l < "$BASE_LOG" | tr -d ' ')
BASE_FOREIGN=$(awk '{for(i=1;i<=NF;i++) if ($i ~ /^foreignProcs=/) {sub("foreignProcs=","",$i); print $i}}' "$BASE_LOG" | sort -n | tail -1)
echo "baseline_samples $BASE_SAMPLES" >> "$RECORD"
echo "baseline_foreign_processes ${BASE_FOREIGN:-unknown}" >> "$RECORD"

# --- 2. the run ------------------------------------------------------------------------------
cd "$REPO" || exit 1
TMPDIR="$WORLD" setsid nohup node tests/soak/rel3-soak.mjs \
  --duration-hours "$HOURS" --keep --out-dir "$WORLD/evidence" \
  > "$WORLD/soak.log" 2>&1 &
SOAK_PID=$!
echo "soak_pid $SOAK_PID" >> "$RECORD"

# --- 3. the run's own telemetry ----------------------------------------------------------------
# The sidecar needs the server's pid for the RSS column, and the pid exists
# only once the server is up.
SERVER_PID=""
for _ in $(seq 1 120); do
  SERVER_PID=$(sed -n 's/.*server ready: pid \([0-9]*\).*/\1/p' "$WORLD/soak.log" 2>/dev/null | head -1)
  [ -n "$SERVER_PID" ] && break
  sleep 5
done
echo "server_pid ${SERVER_PID:-none}" >> "$RECORD"

if [ -n "$SERVER_PID" ]; then
  setsid nohup bash "$TELEMETRY" "$PARENT/telemetry.log" "$SERVER_PID" "$WORLD" > /dev/null 2>&1 &
  echo "telemetry_pid $!" >> "$RECORD"
  echo "telemetry_log $PARENT/telemetry.log" >> "$RECORD"
else
  echo "telemetry NOT STARTED — the server never reported a pid" >> "$RECORD"
fi

echo "baseline_log $BASE_LOG" >> "$RECORD"
echo "soak_log $WORLD/soak.log" >> "$RECORD"
echo "evidence_dir $WORLD/evidence" >> "$RECORD"
echo "launch complete; the record is at $RECORD"
cat "$RECORD"
