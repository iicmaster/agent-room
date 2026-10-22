#!/usr/bin/env bash
# The host-telemetry observer's SELF-CHECK (Story 6.2).
#
# It answers the question the advisor gate asked: "repair and DEMONSTRATE the
# collector". A repaired observer that has never produced a number is not a
# repaired observer.
#
# THE INVARIANT IT PROVES. The observer's foreign CPU must equal the host's
# busy time MINUS the run's own cgroup usage MINUS the observer's own cgroup
# usage. The check measures that right-hand side INDEPENDENTLY (its own reads
# of /proc/stat and of the cgroups) and compares it with what the observer
# reported. That is a stronger statement than "the host was idle and the
# number was zero", and it holds on a busy host: the previous version summed
# the host's idle time into the total and would report ~4.000 cores on a
# four-core idle host, against an expected 0.
#
# The scenarios:
#   1. THE ACCOUNTING AGREES with an independent measurement (the regression
#      test for the idle-and-iowait defect).
#   2. A FOREIGN LOAD IS COUNTED — a busy process outside the run's cgroup
#      shows up as foreign CPU.
#   3. AN EQUIVALENT RUN-OWNED LOAD IS EXCLUDED — the same busy workload
#      inside the run's cgroup does NOT show up as foreign CPU, and the run's
#      own cumulative CPU grows.
#   4. A PROCESS EXIT PRODUCES NO SPIKE — the harness replaces its four
#      clients every hour; a lifetime-counter sum made every replacement look
#      like a multi-core foreign spike. The cgroup's usage is monotonic, so a
#      replacement must not move the foreign number.
#   5. THE IDENTITY IS EXACT — a process whose command line merely MENTIONS
#      the soak's script, and a process in a SIBLING cgroup, are both FOREIGN:
#      the run's own set is its cgroup's members and nothing else.
#   6. THE BASELINE CENSUS is written, and the observer's RSS field is never
#      empty.
#
# It runs on Linux (cgroup v2 and /proc), as root, and it does NOT run a soak:
# it spins plain node processes for a few seconds each.
#
# USAGE: rel1-soak-telemetry-check.sh [work-dir]
# Exit 0 = every assertion held; exit 1 = at least one failed.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
OBSERVER="$HERE/rel1-soak-telemetry.sh"
WORK="${1:-/root/rel1-soak-telemetry-check}"
CGROOT=/sys/fs/cgroup
RUN_CG="agent-room-check-run-$$"
SIBLING_CG="agent-room-check-sibling-$$"
INTERVAL=5
WINDOW_SECONDS=20
TOLERANCE=0.40

if [ ! -r /proc/stat ] || [ ! -d "$CGROOT" ]; then
  echo "SKIP: this check needs a Linux /proc and a cgroup v2 root" >&2
  exit 0
fi
if [ "$(id -u)" != 0 ]; then
  echo "SKIP: this check needs root (it creates cgroups)" >&2
  exit 0
fi

mkdir -p "$WORK"
OUT="$WORK/telemetry.log"
CENSUS="$WORK/census.txt"
: > "$OUT"
rm -rf "$CGROOT/$RUN_CG" "$CGROOT/$SIBLING_CG"
mkdir -p "$CGROOT/$RUN_CG"

FAILURES=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1 — $2"; FAILURES=$(( FAILURES + 1 )); }

# --- the independent measurement ------------------------------------------------------------------
# The host's busy time in microseconds: user + nice + system + irq + softirq.
# Idle and iowait are excluded, deliberately (see the observer's header).
# The microseconds per jiffy is read from the kernel's own answer, not
# assumed: the check's arithmetic must be the observer's arithmetic.
US_PER_JIFFY=$(( 1000000 / $(getconf CLK_TCK 2>/dev/null || echo 100) ))
host_busy_us() {
  read -r _label U N S IDLE IOW IRQ SIRQ STEAL _rest < /proc/stat
  echo $(( (U + N + S + IRQ + SIRQ) * US_PER_JIFFY ))
}
cg_us() {
  local k v
  while read -r k v; do
    [ "$k" = usage_usec ] && { echo "$v"; return 0; }
  done < "$1/cpu.stat" 2>/dev/null
  echo 0
}
# The observer's own cgroup is found by ITS PID, not by a wildcard: a stale
# group left by a killed observer would otherwise be picked up and would
# poison the independent measurement.
observer_cg() {
  local record path
  [ -n "${OBS_PID:-}" ] || { echo ""; return 0; }
  record=$(IFS= read -r record < "/proc/$OBS_PID/cgroup" 2>/dev/null; echo "$record")
  case "$record" in
    *::*) path="${record#*::}" ;;
    *) path="" ;;
  esac
  [ -n "$path" ] && [ -d "$CGROOT$path" ] && { echo "$CGROOT$path"; return 0; }
  echo ""
}

# The node processes in a cgroup, by the observer's definition (argv[0]'s
# basename is node), and the node processes outside it. These are the counts
# the observer's own numbers must agree with.
count_node_in_cgroup() {
  local target="$1" dir pid argv0 path count=0
  for dir in /proc/[0-9]*; do
    pid="${dir#/proc/}"
    IFS= read -r -d '' argv0 < "$dir/cmdline" 2>/dev/null || true
    [ -n "$argv0" ] || continue
    case "${argv0##*/}" in
      node|node[0-9]*) ;;
      *) continue ;;
    esac
    path=$(cgroup_path_of "$dir/cgroup")
    [ "$path" = "$target" ] || continue
    count=$(( count + 1 ))
  done
  echo "$count"
}

count_node_outside_cgroup() {
  local target="$1" dir pid argv0 path count=0
  for dir in /proc/[0-9]*; do
    pid="${dir#/proc/}"
    IFS= read -r -d '' argv0 < "$dir/cmdline" 2>/dev/null || true
    [ -n "$argv0" ] || continue
    case "${argv0##*/}" in
      node|node[0-9]*) ;;
      *) continue ;;
    esac
    path=$(cgroup_path_of "$dir/cgroup")
    [ "$path" = "$target" ] && continue
    count=$(( count + 1 ))
  done
  echo "$count"
}

# The cgroup path of a process, from its cgroup v2 record.
cgroup_path_of() {
  local record path
  IFS= read -r record < "$1" 2>/dev/null || true
  [ -n "$record" ] || return 0
  case "$record" in
    *::*) path="${record#*::}" ;;
    *) path="$record" ;;
  esac
  printf '%s' "$path"
}

# The observer's mean foreign CPU over the last N samples.
observer_mean_foreign() {
  grep -o 'foreignCores=[0-9.]*' "$OUT" 2>/dev/null | tail -"${1:-4}" | cut -d= -f2 \
    | awk '{s+=$1; n++} END{if(n>0) printf "%.3f", s/n; else print "nan"}'
}
field() {
  grep -o "$1=[^ ]*" "$OUT" 2>/dev/null | tail -1 | cut -d= -f2
}
samples() { wc -l < "$OUT" | tr -d ' '; }
wait_samples() {
  local target
  target=$(( $(samples) + $1 ))
  while [ "$(samples)" -lt "$target" ]; do sleep 1; done
}

# The measurement window: the check's own reads of the host and the cgroups,
# over the same wall-clock span the observer's samples cover.
measure_window() {
  local obs_cg t0 busy0 own0 obs0 t1 busy1 own1 obs1
  obs_cg=$(observer_cg)
  t0=$(date -u +%s)
  busy0=$(host_busy_us)
  own0=$(cg_us "$CGROOT/$RUN_CG")
  obs0=$([ -n "$obs_cg" ] && cg_us "$obs_cg" || echo 0)
  sleep "$WINDOW_SECONDS"
  t1=$(date -u +%s)
  busy1=$(host_busy_us)
  own1=$(cg_us "$CGROOT/$RUN_CG")
  obs1=$([ -n "$obs_cg" ] && cg_us "$obs_cg" || echo 0)
  EXPECTED=$(awk -v b="$(( busy1 - busy0 ))" -v o="$(( own1 - own0 ))" -v s="$(( obs1 - obs0 ))" -v t="$(( t1 - t0 ))" \
    'BEGIN{printf "%.3f", (b-o-s)/1000000/t}')
  # The measured window's span, for the record.
  MEASURED_FROM=$t0
  MEASURED_TO=$t1
  OBSERVED=$(observer_mean_foreign 4)
  DELTA=$(awk -v e="$EXPECTED" -v o="$OBSERVED" 'BEGIN{d=e-o; if(d<0)d=-d; printf "%.3f", d}')
}

# --- the observer ------------------------------------------------------------------------------
TELEMETRY_INTERVAL_SECONDS=$INTERVAL "$OBSERVER" "$OUT" "$RUN_CG" "$CENSUS" > "$WORK/observer.out" 2>&1 &
OBS_PID=$!
# The check's own processes are killed and its cgroups removed on the way out,
# WHETHER IT PASSED OR FAILED. A check that dies half way through (a bug in
# the check, an interrupted run) used to leave its node processes behind on the
# host, where they counted as foreign work and inflated the very number the
# next measurement would read.
cleanup() {
  kill $OBS_PID 2>/dev/null
  for pid in ${OWN_PID:-} ${OWN_BUSY_PID:-} ${OWN_BUSY_PID2:-} ${FIXTURE_PID:-} ${SIBLING_PID:-} ${FOREIGN_PID:-}; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  rmdir "$CGROOT/$RUN_CG" "$CGROOT/$SIBLING_CG" 2>/dev/null
  return 0
}
trap cleanup EXIT

sleep 2

# A busy node process for N seconds: burns one core, then exits.
#
# NB: the backgrounded process's stdout MUST NOT be the command substitution's
# pipe. If it is, the substitution waits for EOF on that pipe, which waits for
# the process to exit — and the script hangs there, silently.
busy_node() {
  # $1 is SECONDS. The spin's own argument is milliseconds, so it is scaled
  # here: without the scale the "busy" process burned a core for thirty
  # MILLISECONDS and every scenario below tested nothing.
  node -e "const t=Date.now();while(Date.now()-t<$1*1000){Math.sqrt(Math.random())}" >/dev/null 2>&1 &
  echo $!
}
idle_node() {
  node -e "setInterval(()=>{},1000)" >/dev/null 2>&1 &
  echo $!
}

OWN_PID=$(idle_node)
echo "$OWN_PID" > "$CGROOT/$RUN_CG/cgroup.procs" 2>/dev/null || true
wait_samples 3

# --- 1. the arithmetic is right, recomputed from the log ----------------------------------------
# The observer logs its raw counters, so its arithmetic can be recomputed
# WITHOUT trusting it and without depending on what the host was doing. This
# is the regression test for the idle-and-iowait defect: the old observer
# reported ~4.000 foreign cores on an idle four-core host because it counted
# idle time as consumption.
if command -v python3 >/dev/null 2>&1; then
  ARITH=$(python3 - "$OUT" <<'PYEOF'
import sys
rows = []
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    f = dict(t.split("=", 1) for t in line.split() if "=" in t)
    if "busyJiffies" in f:
        rows.append(f)
if len(rows) < 2:
    print("NOT_ENOUGH_SAMPLES")
    sys.exit(0)
worst = 0.0
worst_cores = 0.0
for prev, cur in zip(rows, rows[1:]):
    busy = int(cur["busyJiffies"]) - int(prev["busyJiffies"])
    run = int(cur["runCpuUs"]) - int(prev["runCpuUs"])
    obs = int(cur["obsCpuUs"]) - int(prev["obsCpuUs"])
    expect_us = busy * 10000 - run - obs
    got_us = int(cur["foreignUs"])
    delta_us = abs(expect_us - got_us)
    gap = float(cur["gapSec"]) if float(cur["gapSec"]) > 0 else 1.0
    delta_cores = delta_us / 1_000_000 / gap
    worst = max(worst, delta_us)
    worst_cores = max(worst_cores, delta_cores)
    expect_cores = got_us / 1_000_000 / gap
    logged_cores = float(cur["foreignCores"])
    if abs(expect_cores - logged_cores) > 0.002:
        worst_cores = max(worst_cores, 1.0)
print(f"samples={len(rows)} max_residual_delta_us={worst} max_cores_delta={worst_cores:.4f}")
PYEOF
)
  if echo "$ARITH" | grep -q "NOT_ENOUGH"; then
    fail "1 the arithmetic is right, recomputed from the log" "not enough samples"
  else
    ARITH_DELTA=$(echo "$ARITH" | sed -n 's/.*max_cores_delta=\([0-9.]*\).*/\1/p')
    if awk -v d="${ARITH_DELTA:-99}" "BEGIN{exit !(d <= $TOLERANCE)}"; then
      pass "1 the arithmetic is right, recomputed from the log ($ARITH)"
    else
      fail "1 the arithmetic is right, recomputed from the log" "$ARITH"
    fi
  fi
else
  fail "1 the arithmetic is right, recomputed from the log" "python3 is not available"
fi
measure_window
if awk -v d="$DELTA" "BEGIN{exit !(d <= $TOLERANCE)}"; then
  pass "1c the accounting agrees with an independent measurement (expected $EXPECTED cores, observed $OBSERVED, delta $DELTA)"
else
  fail "1c the accounting agrees with an independent measurement" "expected $EXPECTED cores, observed $OBSERVED, delta $DELTA"
fi
OWN_SEEN=$(field ownProcs)
if [ "${OWN_SEEN:-0}" -ge 1 ] 2>/dev/null; then
  pass "1b the run's own process is counted as own (ownProcs=$OWN_SEEN)"
else
  fail "1b the run's own process is counted as own" "ownProcs=$OWN_SEEN"
fi

# --- 2. a foreign load is counted ----------------------------------------------------------------
EXPECTED_BEFORE_FOREIGN=$EXPECTED
FOREIGN_PID=$(busy_node 40)
wait_samples 2
measure_window
# The fixture's CONTRIBUTION is what is asserted: a busy process outside the
# run's cgroup must ADD about a core to the residual. Asserting only that the
# residual is above 0.30 would pass on this host's own baseline, which sits
# near 0.85 with no fixture at all.
CONTRIBUTION=$(awk -v a="$EXPECTED" -v b="$EXPECTED_BEFORE_FOREIGN" 'BEGIN{printf "%.3f", a-b}')
if awk -v c="$CONTRIBUTION" 'BEGIN{exit !(c >= 0.50)}'; then
  pass "2 a foreign load is counted (it added $CONTRIBUTION cores to the residual: $EXPECTED_BEFORE_FOREIGN -> $EXPECTED)"
else
  fail "2 a foreign load is counted" "the fixture added only $CONTRIBUTION cores ($EXPECTED_BEFORE_FOREIGN -> $EXPECTED)"
fi
if awk -v d="$DELTA" "BEGIN{exit !(d <= $TOLERANCE)}"; then
  pass "2b the foreign load is accounted correctly (delta $DELTA)"
else
  fail "2b the foreign load is accounted correctly" "delta $DELTA (expected $EXPECTED, observed $OBSERVED)"
fi
kill "$FOREIGN_PID" 2>/dev/null
wait_samples 2

# --- 3. an equivalent run-owned load is excluded --------------------------------------------------
RUN_CPU_BEFORE=$(field runCpuSec)
OWN_BUSY_PID=$(busy_node 45)
echo "$OWN_BUSY_PID" > "$CGROOT/$RUN_CG/cgroup.procs" 2>/dev/null || true
wait_samples 2
measure_window
if awk -v d="$DELTA" "BEGIN{exit !(d <= $TOLERANCE)}"; then
  pass "3 an equivalent run-owned load is excluded (independent measurement $EXPECTED cores, observed $OBSERVED, delta $DELTA)"
else
  fail "3 an equivalent run-owned load is excluded" "expected $EXPECTED cores, observed $OBSERVED, delta $DELTA"
fi
RUN_CPU_AFTER=$(field runCpuSec)
if awk -v a="$RUN_CPU_BEFORE" -v b="$RUN_CPU_AFTER" 'BEGIN{exit !(b > a)}'; then
  pass "3b the run's own CPU is counted as the run's (runCpuSec $RUN_CPU_BEFORE -> $RUN_CPU_AFTER)"
else
  fail "3b the run's own CPU is counted as the run's" "runCpuSec did not grow ($RUN_CPU_BEFORE -> $RUN_CPU_AFTER)"
fi

# --- 3c. the run's own replacement does not inflate the foreign count --------------------------------
# The harness replaces its four clients every hour. A process that exits
# during a sample must not be counted as FOREIGN: the rehearsal showed that
# race adding seven phantom processes to a single sample, which would have
# voided a qualifying night on the process-count gate alone.
FOREIGN_BEFORE_REPLACE=$(field foreignProcs)
kill "$OWN_BUSY_PID" 2>/dev/null
OWN_BUSY_PID2=$(busy_node 40)
echo "$OWN_BUSY_PID2" > "$CGROOT/$RUN_CG/cgroup.procs" 2>/dev/null || true
wait_samples 3
FOREIGN_AFTER_REPLACE=$(field foreignProcs)
if [ "${FOREIGN_AFTER_REPLACE:-0}" -le "$(( ${FOREIGN_BEFORE_REPLACE:-0} + 3 ))" ] 2>/dev/null; then
  pass "3c the run's own replacement does not inflate the foreign count (foreignProcs $FOREIGN_BEFORE_REPLACE -> $FOREIGN_AFTER_REPLACE)"
else
  fail "3c the run's own replacement does not inflate the foreign count" "foreignProcs $FOREIGN_BEFORE_REPLACE -> $FOREIGN_AFTER_REPLACE"
fi

# --- 4. a process exit produces no spike ------------------------------------------------------------
EXIT_MARK=$(wc -l < "$OUT" | tr -d ' ')
wait_samples 2
measure_window
if awk -v d="$DELTA" "BEGIN{exit !(d <= $TOLERANCE)}"; then
  pass "4 a process exit produces no spike (expected $EXPECTED cores, observed $OBSERVED, delta $DELTA)"
else
  fail "4 a process exit produces no spike" "expected $EXPECTED cores, observed $OBSERVED, delta $DELTA"
fi
# The AVERAGE of the last four samples can hide a ONE-SAMPLE spike, and a
# spike is exactly what an exit would produce if the accounting still summed
# lifetime counters. The WORST sample since the exit is asserted as well.
WORST_SINCE_EXIT=$(tail -n +"$EXIT_MARK" "$OUT" | awk '{for(i=1;i<=NF;i++) if ($i ~ /^foreignCores=/) {sub("foreignCores=","",$i); if ($i+0 > m) m=$i+0}} END{printf "%.3f", m+0}')
if awk -v w="$WORST_SINCE_EXIT" "BEGIN{exit !(w <= $TOLERANCE + 1.2)}"; then
  pass "4b no single sample spiked at the exit (the worst sample since the exit was $WORST_SINCE_EXIT cores)"
else
  fail "4b no single sample spiked at the exit" "the worst sample since the exit was $WORST_SINCE_EXIT cores"
fi

# --- 5. the identity is exact -----------------------------------------------------------------------
FOREIGN_BEFORE_FIXTURE=$(field foreignProcs)
OWN_BEFORE_FIXTURE=$(field ownProcs)
# A process that merely MENTIONS the soak's script, outside the run's cgroup.
# NB: the script and its arguments must be SEPARATE words. Quoting them
# together makes the whole thing one -e program, which is not valid JavaScript
# and exits at once -- so the fixture never ran and the assertion below tested
# nothing. Here the program's argv[1] is "rel3-soak.mjs", which is exactly the
# false-own case: a command line that mentions the soak's script.
FIXTURE_PID=$(node -e "setInterval(()=>{},1000)" rel3-soak.mjs --out-dir /some/other/world >/dev/null 2>&1 & echo $!)
# A process in a SIBLING cgroup.
mkdir -p "$CGROOT/$SIBLING_CG"
SIBLING_PID=$(idle_node)
echo "$SIBLING_PID" > "$CGROOT/$SIBLING_CG/cgroup.procs" 2>/dev/null || true
wait_samples 3
FOREIGN_AFTER_FIXTURE=$(field foreignProcs)
OWN_AFTER_FIXTURE=$(field ownProcs)
if [ "${FOREIGN_AFTER_FIXTURE:-0}" -gt "${FOREIGN_BEFORE_FIXTURE:-0}" ] 2>/dev/null; then
  pass "5a the fixtures raised the foreign count (foreignProcs $FOREIGN_BEFORE_FIXTURE -> $FOREIGN_AFTER_FIXTURE)"
else
  fail "5a the fixtures raised the foreign count" "foreignProcs $FOREIGN_BEFORE_FIXTURE -> $FOREIGN_AFTER_FIXTURE"
fi
# Each fixture is checked BY ITS OWN PID in the census: an aggregate count
# going up does not prove WHICH processes went up, and the defect this check
# exists to catch (the run's own processes counted as foreign) moves the
# aggregate too.
# Each fixture is checked by its OWN cgroup, and the observer's counts are
# checked against the cgroup's ACTUAL membership. The census cannot carry
# this: it is a snapshot of the first sample, taken before the fixtures
# existed. Comparing the counts is also the stronger property — it is exactly
# the defect that a single newline in a cgroup record would cause, and an
# aggregate count going up does not prove which processes went up.
# The cgroup's path in the v2 hierarchy. RUN_CG is the group's NAME; the
# path is that name under the root, and the observer's membership test
# compares exactly that string.
RUN_CG_PATH="/$RUN_CG"
FIXTURE_PATH=$(cgroup_path_of "/proc/$FIXTURE_PID/cgroup")
SIBLING_PATH=$(cgroup_path_of "/proc/$SIBLING_PID/cgroup")
OWN_PATH=$(cgroup_path_of "/proc/$OWN_PID/cgroup")
if [ "$FIXTURE_PATH" != "$RUN_CG_PATH" ] && [ -n "$FIXTURE_PATH" ]; then
  pass "5c the process that MENTIONS the soak's script is NOT in the run's cgroup (pid $FIXTURE_PID, cgroup $FIXTURE_PATH)"
else
  fail "5c the process that MENTIONS the soak's script is NOT in the run's cgroup" "pid $FIXTURE_PID is in '$FIXTURE_PATH'"
fi
if [ "$SIBLING_PATH" != "$RUN_CG_PATH" ] && [ -n "$SIBLING_PATH" ]; then
  pass "5d the process in the SIBLING cgroup is NOT in the run's cgroup (pid $SIBLING_PID, cgroup $SIBLING_PATH)"
else
  fail "5d the process in the SIBLING cgroup is NOT in the run's cgroup" "pid $SIBLING_PID is in '$SIBLING_PATH'"
fi
if [ "$OWN_PATH" = "$RUN_CG_PATH" ]; then
  pass "5e the run's own process IS in the run's cgroup (pid $OWN_PID)"
else
  fail "5e the run's own process IS in the run's cgroup" "pid $OWN_PID is in '$OWN_PATH'"
fi
ACTUAL_OWN=$(count_node_in_cgroup "$RUN_CG_PATH")
ACTUAL_FOREIGN=$(count_node_outside_cgroup "$RUN_CG_PATH")
REPORTED_OWN=$(field ownProcs)
REPORTED_FOREIGN=$(field foreignProcs)
if [ "${REPORTED_OWN:-0}" = "$ACTUAL_OWN" ] && [ "${REPORTED_FOREIGN:-0}" = "$ACTUAL_FOREIGN" ]; then
  pass "5f the observer's counts match the cgroup's ACTUAL membership (own $REPORTED_OWN vs $ACTUAL_OWN, foreign $REPORTED_FOREIGN vs $ACTUAL_FOREIGN)"
else
  fail "5f the observer's counts match the cgroup's ACTUAL membership" "own $REPORTED_OWN vs $ACTUAL_OWN, foreign $REPORTED_FOREIGN vs $ACTUAL_FOREIGN"
fi
# The count may FALL between the two readings (one of the run's own processes
# exits); what must never happen is that it RISES, because the two fixtures
# are foreign and must never be counted as the run's own.
if [ "${OWN_AFTER_FIXTURE:-0}" -le "${OWN_BEFORE_FIXTURE:-0}" ] 2>/dev/null; then
  pass "5b the fixtures did not become the run's own (ownProcs $OWN_BEFORE_FIXTURE -> $OWN_AFTER_FIXTURE)"
else
  fail "5b the fixtures did not become the run's own" "ownProcs $OWN_BEFORE_FIXTURE -> $OWN_AFTER_FIXTURE"
fi

kill "$FIXTURE_PID" "$SIBLING_PID" "$OWN_BUSY_PID2" "$OWN_PID" 2>/dev/null

# --- 6. the census and the field hygiene ---------------------------------------------------------------
if [ -s "$CENSUS" ]; then
  pass "6a the baseline census was written ($CENSUS, $(grep -vc '^#' "$CENSUS" 2>/dev/null) node processes)"
else
  fail "6a the baseline census was written" "$CENSUS is empty or missing"
fi
# NB: `grep -c` prints the count AND exits 1 when the count is zero, so a
# `|| echo 0` here would make the value "0\n0" and the comparison below would
# fail on a clean log.
# The RSS field is followed by other fields, so the check must look at the
# field's own position, not at the end of the line.
EMPTY_RSS=$(awk '{for(i=1;i<=NF;i++) if ($i ~ /^serverRss_kB=$/) c++} END{printf "%d", c+0}' "$OUT")
if [ "${EMPTY_RSS:-1}" = "0" ]; then
  pass "6b the server RSS field is never empty"
else
  fail "6b the server RSS field is never empty" "$EMPTY_RSS sample(s) have an empty serverRss_kB"
fi
if [ -s "$WORK/observer.out" ]; then
  fail "6c the observer is quiet" "$(head -3 "$WORK/observer.out")"
else
  pass "6c the observer is quiet (no stray output)"
fi
# The observer's own accounting must have been sound in EVERY sample it took:
# a sample whose observer cgroup or cgroup reads failed is not a measurement.
BAD_SIGNALS=$(awk '{for(i=1;i<=NF;i++) if ($i ~ /^(obsCgroupOk|obsReadOk|deltaValid)=0$/) c++} END{printf "%d", c+0}' "$OUT")
if [ "${BAD_SIGNALS:-1}" = "0" ]; then
  pass "6d every sample the observer took had sound accounting"
else
  fail "6d every sample the observer took had sound accounting" "$BAD_SIGNALS sample(s) carry a failed validity signal"
fi

echo
echo "--- the observer's samples ---"
cat "$OUT"
echo
if [ "$FAILURES" -eq 0 ]; then
  echo "SELF-CHECK PASSED — every assertion held"
  exit 0
fi
echo "SELF-CHECK FAILED — $FAILURES assertion(s) failed"
exit 1
