#!/usr/bin/env bash
# Launch the REL-3 qualifying soak on the quiet host, under the corrected
# quiet-host contract (Story 6.2; the 2026-10-22 amendment).
#
# WHY A LAUNCH SCRIPT. The first twelve-hour run under the contract was typed
# by hand over ssh, and the contract it ran under turned out to be
# unsatisfiable on this host (F18 in the Epic 6 retro). The next run is
# scripted, so that what it measured and how it was launched are the same
# thing every time.
#
# WHAT IT DOES, IN ORDER:
#   1. creates the RUN'S CGROUP — the run's identity for the observer, and the
#      source of the run's own CPU (monotonic across the harness's hourly
#      client replacement);
#   2. starts the observer and measures the BASELINE — the host's foreign
#      state over BASELINE_MINUTES minutes BEFORE the run exists — and writes
#      the baseline census (the foreign processes' identities, pinned to this
#      boot);
#   3. launches the soak INSIDE the cgroup, with its world under the run's
#      own directory (never /tmp — macOS temp cleanup ate a credential during
#      an earlier run) and its stdout in soak.log;
#   4. checks, at the first samples of the run, that the own/foreign split is
#      what it should be — the run's own processes counted as own, the host's
#      baseline counted as foreign — and says so in the launch record. An
#      operator argument typo (a world path that is not the harness's
#      realpath) shows up HERE, at minute one, instead of at hour twelve.
#
# The run itself is untouched: it materializes the candidate, proves its
# identity against the frozen record, and applies the pre-registered gates.
#
# USAGE: rel3-soak-launch.sh <repo-dir> <parent-dir> [duration-hours]
set -u

REPO="${1:?usage: rel3-soak-launch.sh <repo-dir> <parent-dir> [duration-hours]}"
PARENT="${2:?usage: rel3-soak-launch.sh <repo-dir> <parent-dir> [duration-hours]}"
HOURS="${3:-12}"

WORLD="$PARENT/.soak-world"
RECORD="$PARENT/launch-record.txt"
TELEMETRY="$REPO/scripts/rel1-soak-telemetry.sh"
CGROOT=/sys/fs/cgroup
BASELINE_MINUTES=15
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN_CG="agent-room-soak-$STAMP"

if [ ! -r "$TELEMETRY" ]; then
  echo "rel3-soak-launch: $TELEMETRY is missing — the run has no telemetry source" >&2
  exit 2
fi
if [ ! -d "$CGROOT" ]; then
  echo "rel3-soak-launch: $CGROOT is missing — the observer needs a cgroup v2 root" >&2
  exit 2
fi

mkdir -p "$WORLD"
rm -rf "$CGROOT/$RUN_CG"
mkdir -p "$CGROOT/$RUN_CG"

: > "$RECORD"
{
  echo "launched_at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "repo $REPO"
  echo "parent $PARENT"
  echo "duration_hours $HOURS"
  echo "run_cgroup $RUN_CG"
  echo "baseline_minutes $BASELINE_MINUTES"
  echo "node $(node --version)"
  echo "host $(uname -srm)"
  echo "cores $(nproc)"
  echo "boot_id $(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
} >> "$RECORD"

TELEMETRY_LOG="$PARENT/telemetry.log"
CENSUS="$PARENT/baseline-census.txt"

# --- 1-2. the observer, and the baseline --------------------------------------------------------
# The observer starts BEFORE the run, so its log is one continuous series: the
# baseline samples first (no run present), then the run's samples. The scorer
# reads the baseline from the samples before the run's first own process.
: > "$TELEMETRY_LOG"
setsid nohup bash "$TELEMETRY" "$TELEMETRY_LOG" "$RUN_CG" "$CENSUS" > "$PARENT/observer.out" 2>&1 &
OBS_PID=$!
echo "observer_pid $OBS_PID" >> "$RECORD"
echo "telemetry_log $TELEMETRY_LOG" >> "$RECORD"
echo "census $CENSUS" >> "$RECORD"

# The baseline window: the host's foreign state, measured before the run
# exists. The contract's foreign thresholds are relative to THIS.
sleep $(( BASELINE_MINUTES * 60 ))
BASE_SAMPLES=$(grep -c . "$TELEMETRY_LOG" 2>/dev/null || echo 0)
BASE_FOREIGN=$(grep -o 'foreignProcs=[0-9]*' "$TELEMETRY_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
BASE_CPU_MEAN=$(awk '{for(i=1;i<=NF;i++) if ($i ~ /^foreignCores=/) {sub("foreignCores=","",$i); s+=$i; n++}} END{if(n>0) printf "%.3f", s/n; else print "unknown"}' "$TELEMETRY_LOG" 2>/dev/null)
{
  echo "baseline_samples $BASE_SAMPLES"
  echo "baseline_foreign_processes ${BASE_FOREIGN:-unknown}"
  echo "baseline_foreign_cores_mean $BASE_CPU_MEAN"
} >> "$RECORD"

# --- 3. the run ---------------------------------------------------------------------------------
# The soak is started through a shell that moves ITSELF into the cgroup before
# it execs node, so the run and every process it spawns inherit the cgroup.
cd "$REPO" || exit 1
setsid nohup bash -c "
  echo \$\$ > '$CGROOT/$RUN_CG/cgroup.procs' 2>/dev/null || true
  exec env TMPDIR='$WORLD' node tests/soak/rel3-soak.mjs --duration-hours '$HOURS' --keep --out-dir '$WORLD/evidence'
" > "$WORLD/soak.log" 2>&1 &
SOAK_PID=$!
echo "soak_pid $SOAK_PID" >> "$RECORD"
echo "soak_log $WORLD/soak.log" >> "$RECORD"
echo "evidence_dir $WORLD/evidence" >> "$RECORD"

# --- 4. the minute-one own/foreign check ----------------------------------------------------------
# The observer's first samples with the run present must show the run's own
# processes counted as OWN and the host's baseline counted as FOREIGN.
sleep 150
FIRST_OWN=$(grep -o 'ownProcs=[0-9]*' "$TELEMETRY_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
FIRST_FOREIGN=$(grep -o 'foreignProcs=[0-9]*' "$TELEMETRY_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
{
  echo "minute_one_own_processes ${FIRST_OWN:-unknown}"
  echo "minute_one_foreign_processes ${FIRST_FOREIGN:-unknown}"
  echo "minute_one_note the run's own processes (runner, server, four clients, recorder) must be counted as own; if ownProcs is 0 the world path or the cgroup is wrong and the operator should stop the run now"
} >> "$RECORD"

echo "launch complete; the record is at $RECORD"
cat "$RECORD"
