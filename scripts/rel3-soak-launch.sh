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
#   1. BINDS THE RULE. The thresholds file's digest, the digests of the
#      observer, the self-check, the scorer and the launch script itself, the
#      repository's commit, and the exact adjudication command are written
#      into the launch record BEFORE anything runs. "Frozen" means committed
#      and pinned by digest — a working tree that one `git checkout` away
#      stops existing is not a registration.
#   2. creates the RUN'S CGROUP — the run's identity for the observer, and the
#      source of the run's own CPU (monotonic across the harness's hourly
#      client replacement);
#   3. starts the observer and waits for it to report a READY sample whose
#      validity signals are all good; an observer that cannot do its job stops
#      the launch rather than producing a log nobody can score;
#   4. measures the BASELINE — the host's foreign state over BASELINE_MINUTES
#      minutes BEFORE the run exists — and records it with its digest;
#   5. launches the soak INSIDE the cgroup and VERIFIES the placement: if the
#      runner is not in the cgroup, the run is stopped at once, because a run
#      whose own processes are not attributable cannot be scored honestly;
#   6. checks, at minute one, that the own/foreign partition is what it must
#      be — and STOPS THE RUN if it is not.
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
SCORER="$REPO/scripts/rel3-soak-eligibility.mjs"
THRESHOLDS="$REPO/docs/implementation/rel3-quiet-host-thresholds.json"
CGROOT=/sys/fs/cgroup
# The baseline window's length, in minutes. The qualifying run uses the
# default; the override exists so the launch path can be REHEARSED without
# waiting a quarter of an hour, and the value actually used is recorded.
BASELINE_MINUTES="${BASELINE_MINUTES:-15}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN_CG="agent-room-soak-$STAMP"

if [ ! -r "$TELEMETRY" ] || [ ! -r "$SCORER" ] || [ ! -r "$THRESHOLDS" ]; then
  echo "rel3-soak-launch: the observer, the scorer or the thresholds file is missing" >&2
  exit 2
fi
if [ ! -d "$CGROOT" ]; then
  echo "rel3-soak-launch: $CGROOT is missing — the observer needs a cgroup v2 root" >&2
  exit 2
fi

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

mkdir -p "$WORLD"
rm -rf "$CGROOT/$RUN_CG"
mkdir -p "$CGROOT/$RUN_CG"

TELEMETRY_LOG="$PARENT/telemetry.log"
CENSUS="$PARENT/baseline-census.txt"

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
  # --- the binding of the rule -------------------------------------------------
  echo "repo_commit $(cd "$REPO" && git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "repo_changed_paths $(cd "$REPO" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  echo "thresholds_file $THRESHOLDS"
  echo "thresholds_digest sha256:$(digest "$THRESHOLDS")"
  echo "observer_digest sha256:$(digest "$TELEMETRY")"
  echo "scorer_digest sha256:$(digest "$SCORER")"
  echo "launcher_digest sha256:$(digest "$0")"
} >> "$RECORD"

# --- 1. the observer, and its readiness -------------------------------------------
# The observer starts BEFORE the run, so its log is one continuous series: the
# baseline samples first (no run present), then the run's samples.
: > "$TELEMETRY_LOG"
setsid nohup bash "$TELEMETRY" "$TELEMETRY_LOG" "$RUN_CG" "$CENSUS" > "$PARENT/observer.out" 2>&1 &
OBS_PID=$!
echo "observer_pid $OBS_PID" >> "$RECORD"
echo "telemetry_log $TELEMETRY_LOG" >> "$RECORD"
echo "census $CENSUS" >> "$RECORD"

# The observer must produce a sample whose own validity signals are good. An
# observer that cannot account for its own CPU, or cannot read the run's
# cgroup, would make every sample unscoreable — so the launch waits for a
# good one and gives up rather than starting a night nobody could judge.
READY=0
for _ in $(seq 1 30); do
  sleep 2
  if [ -s "$TELEMETRY_LOG" ]; then
    LAST=$(tail -1 "$TELEMETRY_LOG")
    case "$LAST" in
      *"obsCgroupOk=1"*"obsReadOk=1"*"deltaValid=1"*) READY=1 ;;
    esac
    [ "$READY" = 1 ] && break
  fi
done
if [ "$READY" != 1 ]; then
  echo "observer_not_ready — the launch is stopped; see $PARENT/observer.out" >> "$RECORD"
  kill "$OBS_PID" 2>/dev/null
  echo "rel3-soak-launch: the observer did not report a valid sample; the launch is stopped" >&2
  exit 3
fi
echo "observer_ready yes" >> "$RECORD"

# --- 2. the baseline ---------------------------------------------------------------
# The host's foreign state, measured before the run exists. The contract's
# foreign thresholds are REGISTERED against a measurement of this host, so
# this window is recorded with its digest and handed to the scorer as the
# named source to CROSS-CHECK the registration against.
sleep $(( BASELINE_MINUTES * 60 ))
BASE_SAMPLES=$(grep -c . "$TELEMETRY_LOG" 2>/dev/null)
BASE_SAMPLES=${BASE_SAMPLES:-0}
BASE_FOREIGN=$(grep -o 'foreignProcs=[0-9]*' "$TELEMETRY_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
{
  echo "baseline_samples $BASE_SAMPLES"
  echo "baseline_foreign_processes ${BASE_FOREIGN:-unknown}"
  echo "baseline_log $TELEMETRY_LOG"
  echo "baseline_log_digest sha256:$(digest "$TELEMETRY_LOG")"
  echo "baseline_census_digest sha256:$(digest "$CENSUS" 2>/dev/null || echo none)"
} >> "$RECORD"

# The host's baseline must still be the baseline the rule was REGISTERED
# against. If it has moved, the registration is stale — and that is caught
# HERE, before the night, not after it: the operator re-registers and starts
# again, which costs minutes; discovering it after a twelve-hour run costs the
# run.
BASELINE_CHECK=$(python3 - "$TELEMETRY_LOG" "$THRESHOLDS" <<'PYEOF'
import json, math, sys
log, thresholds = sys.argv[1], sys.argv[2]
rows = []
for line in open(log, encoding="utf-8", errors="replace"):
    fields = dict(t.split("=", 1) for t in line.split() if "=" in t)
    if "foreignCores" in fields:
        rows.append(fields)
measured = [row for row in rows if row.get("interval") == "1"]
if len(measured) < 6:
    print("too_few_samples")
    raise SystemExit(0)
cores = sorted(float(row["foreignCores"]) for row in measured)
rank = math.ceil(0.5 * len(cores))
median = cores[max(1, min(rank, len(cores))) - 1]
mean = sum(cores) / len(cores)
config = json.load(open(thresholds, encoding="utf-8"))
expectation = config.get("baselineExpectation") or {}
tolerance = expectation.get("tolerance") or {}
median_tolerance = float(tolerance.get("median", 0.15))
mean_tolerance = float(tolerance.get("mean", 0.25))
median_drift = abs(median - float(expectation.get("median", median)))
mean_drift = abs(mean - float(expectation.get("mean", mean)))
verdict = "ok" if (median_drift <= median_tolerance and mean_drift <= mean_tolerance) else "moved"
print(f"{verdict} samples={len(measured)} median={median:.4f} mean={mean:.4f} median_drift={median_drift:.4f} mean_drift={mean_drift:.4f}")
PYEOF
)
echo "baseline_check $BASELINE_CHECK" >> "$RECORD"
case "$BASELINE_CHECK" in
  ok\ *)
    echo "baseline_check_ok yes" >> "$RECORD"
    ;;
  *)
    echo "baseline_check_failed — the host's baseline has moved since the registration, so the run is NOT started" >> "$RECORD"
    kill "$OBS_PID" 2>/dev/null
    echo "rel3-soak-launch: the host's baseline has moved since the registration ($BASELINE_CHECK); the run is not started" >&2
    exit 6
    ;;
esac

# --- 3. the run ---------------------------------------------------------------------
cd "$REPO" || exit 1
# The soak is started through a shell that moves ITSELF into the cgroup before
# it execs node, so the run and every process it spawns inherit the cgroup.
setsid nohup bash -c "
  echo \$\$ > '$CGROOT/$RUN_CG/cgroup.procs' 2>/dev/null || exit 70
  exec env TMPDIR='$WORLD' node tests/soak/rel3-soak.mjs --duration-hours '$HOURS' --keep --out-dir '$WORLD/evidence'
" > "$WORLD/soak.log" 2>&1 &
SOAK_PID=$!
sleep 5
# The placement is VERIFIED, not assumed. A run whose own processes are not in
# the cgroup cannot be scored honestly: its CPU would be foreign and its
# identity invisible.
PLACED=0
if grep -q "^${SOAK_PID}\$" "$CGROOT/$RUN_CG/cgroup.procs" 2>/dev/null; then
  PLACED=1
fi
echo "cgroup_placement $([ "$PLACED" = 1 ] && echo verified || echo FAILED)" >> "$RECORD"
if [ "$PLACED" != 1 ]; then
  echo "cgroup_placement_failed — the run is stopped" >> "$RECORD"
  kill "$SOAK_PID" 2>/dev/null
  kill "$OBS_PID" 2>/dev/null
  echo "rel3-soak-launch: the run did not enter its cgroup; the launch is stopped" >&2
  exit 4
fi
echo "soak_pid $SOAK_PID" >> "$RECORD"
echo "soak_log $WORLD/soak.log" >> "$RECORD"
echo "evidence_dir $WORLD/evidence" >> "$RECORD"

# --- 4. the minute-one partition check, ENFORCED --------------------------------------
# The observer's first samples with the run present must show the run's own
# processes counted as OWN and the host's baseline counted as FOREIGN. An
# operator mistake (a world path that is not the harness's realpath, or a
# cgroup that did not take) shows up HERE, at minute one — not at hour twelve.
sleep 150
FIRST_OWN=$(grep -o 'ownProcs=[0-9]*' "$TELEMETRY_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
FIRST_FOREIGN=$(grep -o 'foreignProcs=[0-9]*' "$TELEMETRY_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
OWN_MIN=6
{
  echo "minute_one_own_processes ${FIRST_OWN:-unknown}"
  echo "minute_one_foreign_processes ${FIRST_FOREIGN:-unknown}"
  echo "minute_one_expected_own_minimum $OWN_MIN"
} >> "$RECORD"
if [ "${FIRST_OWN:-0}" -lt "$OWN_MIN" ] 2>/dev/null; then
  echo "minute_one_failed — the own/foreign partition is wrong, so the run is stopped" >> "$RECORD"
  kill "$SOAK_PID" 2>/dev/null
  kill "$OBS_PID" 2>/dev/null
  echo "rel3-soak-launch: only ${FIRST_OWN:-0} own processes were seen (expected at least $OWN_MIN); the run is stopped" >&2
  exit 5
fi
echo "minute_one_ok yes" >> "$RECORD"

# --- 5. the adjudication command, recorded before the night --------------------------
{
  echo "adjudication_command node scripts/rel3-soak-eligibility.mjs --telemetry $TELEMETRY_LOG --baseline-extra $TELEMETRY_LOG --run-start <the run's start, from soak.log> --run-end <the run's end, from the results> --thresholds $THRESHOLDS --expect-thresholds-digest sha256:$(digest "$THRESHOLDS") --out <the attempt's eligibility.json>"
  echo "adjudication_note the scorer reads the FROZEN limits from the thresholds file; the baseline is a CROSS-CHECK, not the source of the limits"
} >> "$RECORD"

# The observer is stopped when the run ends, so the log ends with the run
# rather than trailing on: a window is scored against the run, and a log that
# keeps running past the run would make the window's end ambiguous.
(
  while kill -0 "$SOAK_PID" 2>/dev/null; do sleep 30; done
  sleep 65
  kill "$OBS_PID" 2>/dev/null
) &
echo "observer_watcher_pid $!" >> "$RECORD"

echo "launch complete; the record is at $RECORD"
cat "$RECORD"
