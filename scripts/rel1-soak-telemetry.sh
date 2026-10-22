#!/usr/bin/env bash
# The REL-3 soak's host-telemetry observer (Story 6.2; the 2026-10-22 amendment).
# It is a READ-ONLY observer of the HOST: it touches no repository code,
# changes no gate, and writes one line a minute beside the run.
#
# WHY IT EXISTS. A soak's memory verdict is only as good as the host it ran on:
# a neighbour's workload on the same machine changes what the server's RSS
# does. The observer exists so that question is ANSWERED BY MEASUREMENT rather
# than asserted.
#
# WHAT CHANGED IN THIS VERSION, AND WHY. The previous version was reviewed by
# two advisor lanes and found broken in two ways; both defects are fixed here.
#
#   1. THE RUN'S OWN CPU IS THE CGROUP'S, NOT A SUM OVER LIVING PROCESSES.
#      The harness closes and respawns its four client processes at every
#      hourly reconnect. Summing the lifetime counters of the processes alive
#      at each sample, and subtracting successive sums, produced a large
#      NEGATIVE run delta the moment a client exited -- a spurious multi-core
#      "foreign" spike once an hour, inside the measured window. The cgroup's
#      cpu.stat (usage_usec) is MONOTONIC and survives process exit by
#      construction, so the accounting cannot have that artifact. It also
#      gives the run's own IDENTITY exactly: the run's processes are the
#      cgroup's members, so nothing is classified by a substring of its
#      command line (a neighbour whose command line merely mentioned the
#      soak's script was previously counted as the run's own).
#
#   2. BUSY CPU EXCLUDES IDLE AND IOWAIT. The previous version summed
#      user+nice+system+IDLE+IOWAIT+irq+softirq, so the "foreign CPU" of an
#      entirely idle four-core host read 4.000 cores -- the gate was a
#      tautology of failure. Busy is user+nice+system+irq+softirq; `steal` is
#      reported separately rather than silently folded into ordinary process
#      CPU. Iowait is excluded deliberately: on this host the soak's own
#      fsync waits land there, and counting them would charge the run's own
#      I/O to a neighbour.
#
#   3. THE OBSERVER MEASURES ITS OWN COST AND EXCLUDES IT. The observer moves
#      itself into its own cgroup, and that cgroup's usage is subtracted from
#      the residual, so the observer can never inflate the number it reports.
#      The per-minute sample is fork-free (every per-process read is a bash
#      builtin); only the one-time census uses ordinary tools.
#
# COMPARABILITY, STATED PLAINLY. Earlier archived telemetry (attempts 3, 4 and
# 5) was collected by a DIFFERENT observer with a different counter, and this
# file's fields do NOT line up with theirs. Only the observations collected by
# THIS version are comparable with each other. The archived logs are kept as
# they are; they are not restated.
#
# WHAT IT MEASURES, per sample:
#   load           the 1/5/15-minute load averages (REPORTED, never gated: the
#                  load average counts uninterruptible tasks, so a
#                  synchronous=FULL store generates load with an idle CPU)
#   memAvailable   the host's available memory (kB)
#   nodeProcs      the host's node process count (total)
#   ownProcs       the node processes belonging to THIS run
#   foreignProcs   the node processes that are NOT the run's own
#   foreignCores   the host's CPU consumed by processes OTHER than the run's
#                  own and OTHER than this observer, in CORES
#   stealCores     the host's stolen time, in cores (reported, not attributed)
#   serverRss_kB   the run's server child's RSS
#   pgmajfault     the host's major-fault counter
#   runCpuSec      the run's cumulative CPU, from its cgroup
#   gapSec         the seconds since the previous sample (a gap is a gap)
#
# USAGE: rel1-soak-telemetry.sh <out-file> <run-cgroup> [census-file]
set -u

OUT="${1:?usage: rel1-soak-telemetry.sh <out-file> <run-cgroup> [census-file]}"
RUN_CG_NAME="${2:?usage: rel1-soak-telemetry.sh <out-file> <run-cgroup> [census-file]}"
CENSUS_OUT="${3:-}"

CGROOT=/sys/fs/cgroup
RUN_CG="$CGROOT/$RUN_CG_NAME"
OBS_CG="$CGROOT/agent-room-observer-$$"

if [ ! -r /proc/stat ] || [ ! -d "$CGROOT" ]; then
  echo "rel1-soak-telemetry: this observer needs a Linux /proc and a cgroup v2 root" >&2
  exit 2
fi

HZ=$(getconf CLK_TCK 2>/dev/null || echo 100)
US_PER_JIFFY=$(( 1000000 / HZ ))

# The sample cadence. 60 s is the cadence the contract is scored against, and
# the eligibility scorer rejects any telemetry whose gaps are not 60 s, so a
# different cadence cannot silently become a qualifying run. The override
# exists ONLY so the self-check does not have to take ten minutes.
INTERVAL="${TELEMETRY_INTERVAL_SECONDS:-60}"

# Move the observer into its own cgroup, so its own CPU is attributable and
# excluded from the foreign residual.
if mkdir -p "$OBS_CG" 2>/dev/null && echo $$ > "$OBS_CG/cgroup.procs" 2>/dev/null; then
  :
else
  OBS_CG=""
fi
cleanup() {
  [ -n "$OBS_CG" ] && rmdir "$OBS_CG" 2>/dev/null
  return 0
}
trap cleanup EXIT

# The cgroup's CPU in microseconds. Monotonic across process exit.
cg_usage_usec() {
  local k v
  while read -r k v; do
    if [ "$k" = usage_usec ]; then
      printf '%s' "$v"
      return 0
    fi
  done < "$1/cpu.stat" 2>/dev/null
  printf '0'
}

# The whole command line of a process, NULs turned into spaces. Reads the file
# field by field, so it costs no subprocess. Sets CMDLINE.
CMDLINE=""
read_cmdline() {
  local field out=""
  while IFS= read -r -d '' field; do
    out="$out $field"
  done < "$1" 2>/dev/null
  CMDLINE="${out# }"
}

# Is this argv[0] a node binary? The definition is exact and stated in the
# census header, because a baseline measured by one counter cannot be compared
# with a count taken by another.
is_node_argv0() {
  case "${1##*/}" in
    node|node[0-9]*) return 0 ;;
  esac
  return 1
}

PREV_BUSY_US=0
PREV_RUN_US=0
PREV_OBS_US=0
PREV_STEAL_US=0
PREV_TS=0
FIRST=1

while true; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  NOW=$(date -u +%s)

  # --- the host ---------------------------------------------------------------------------
  read -r _label U N S IDLE IOW IRQ SIRQ STEAL _rest < /proc/stat
  BUSY_JIFFIES=$(( U + N + S + IRQ + SIRQ ))
  BUSY_US=$(( BUSY_JIFFIES * US_PER_JIFFY ))
  STEAL_US=$(( STEAL * US_PER_JIFFY ))

  read -r l1 l2 l3 _rest < /proc/loadavg
  LOAD="$l1 $l2 $l3"
  FREE=0
  while read -r k v _rest; do
    [ "$k" = "MemAvailable:" ] && { FREE="$v"; break; }
  done < /proc/meminfo
  MAJ=0
  while read -r k v _rest; do
    [ "$k" = pgmajfault ] && { MAJ="$v"; break; }
  done < /proc/vmstat

  # --- the run's own processes and CPU -----------------------------------------------------
  OWN_PROCS=0
  SERVER_RSS=0
  RUN_US=0
  if [ -d "$RUN_CG" ]; then
    RUN_US=$(cg_usage_usec "$RUN_CG")
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      d="/proc/$pid"
      { IFS= read -r -d '' argv0 < "$d/cmdline"; } 2>/dev/null || true
      if is_node_argv0 "$argv0"; then
        OWN_PROCS=$(( OWN_PROCS + 1 ))
      fi
      # The server child is recognised by its entry point, INSIDE the run's own
      # cgroup -- so this cannot match a neighbour.
      read_cmdline "$d/cmdline"
      case "$CMDLINE" in
        *server/api/server.mjs*)
          while read -r k v _rest; do
            if [ "$k" = "VmRSS:" ]; then SERVER_RSS="$v"; break; fi
          done < "$d/status" 2>/dev/null
          ;;
      esac
    done < "$RUN_CG/cgroup.procs" 2>/dev/null
  fi

  # --- the host's node processes that are not the run's --------------------------------------
  FOREIGN_PROCS=0
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    { IFS= read -r -d '' argv0 < "$d/cmdline"; } 2>/dev/null || true
    [ -n "$argv0" ] || continue
    is_node_argv0 "$argv0" || continue
    # Membership by cgroup, never by a substring of the command line.
    { IFS= read -r -d '' cgline < "$d/cgroup"; } 2>/dev/null || true
    case "$cgline" in
      *"/$RUN_CG_NAME") continue ;;
    esac
    FOREIGN_PROCS=$(( FOREIGN_PROCS + 1 ))
  done
  NODE_PROCS=$(( OWN_PROCS + FOREIGN_PROCS ))

  OBS_US=0
  [ -n "$OBS_CG" ] && OBS_US=$(cg_usage_usec "$OBS_CG")

  # --- the residual ------------------------------------------------------------------------
  FOREIGN_CORES=0.000
  STEAL_CORES=0.000
  FOREIGN_US=0
  GAP=0
  if [ "$PREV_TS" -gt 0 ] && [ "$NOW" -gt "$PREV_TS" ]; then
    GAP=$(( NOW - PREV_TS ))
    FOREIGN_US=$(( BUSY_US - PREV_BUSY_US - (RUN_US - PREV_RUN_US) - (OBS_US - PREV_OBS_US) ))
    [ "$FOREIGN_US" -lt 0 ] && FOREIGN_US=0
    FOREIGN_CORES=$(awk -v us="$FOREIGN_US" -v s="$GAP" 'BEGIN{printf "%.3f", us/(1000000*s)}')
    STEAL_DELTA_US=$(( STEAL_US - PREV_STEAL_US ))
    [ "$STEAL_DELTA_US" -lt 0 ] && STEAL_DELTA_US=0
    STEAL_CORES=$(awk -v us="$STEAL_DELTA_US" -v s="$GAP" 'BEGIN{printf "%.3f", us/(1000000*s)}')
  fi
  PREV_BUSY_US="$BUSY_US"
  PREV_RUN_US="$RUN_US"
  PREV_OBS_US="$OBS_US"
  PREV_STEAL_US="$STEAL_US"
  PREV_TS="$NOW"

  # The raw counters are logged as well as the derived ones, so that the
  # arithmetic can be recomputed from the log alone (the self-check does
  # exactly that) without trusting the observer's own arithmetic.
  echo "$TS load=$LOAD memAvailable_kB=${FREE:-0} nodeProcs=$NODE_PROCS ownProcs=$OWN_PROCS foreignProcs=$FOREIGN_PROCS foreignCores=$FOREIGN_CORES stealCores=$STEAL_CORES serverRss_kB=$SERVER_RSS pgmajfault=${MAJ:-0} runCpuSec=$(awk -v u="$RUN_US" 'BEGIN{printf "%.1f", u/1000000}') gapSec=$GAP busyJiffies=$BUSY_JIFFIES runCpuUs=$RUN_US obsCpuUs=$OBS_US foreignUs=${FOREIGN_US:-0}" >> "$OUT"

  # --- the baseline census (once) ------------------------------------------------------------
  # The foreign processes are PINNED: identity, arguments and start time,
  # bound to this boot. A baseline that is only a number in prose is not a
  # baseline. (One-time, so ordinary tools are fine here.)
  if [ "$FIRST" = 1 ] && [ -n "$CENSUS_OUT" ]; then
    {
      echo "# foreign-process census"
      echo "# boot_id $(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
      echo "# sampled_at $TS"
      echo "# node_process_definition a process whose argv[0] basename is node, or node followed by digits"
      echo "# format pid own starttime argv0 argv1"
      for d in /proc/[0-9]*; do
        pid="${d#/proc/}"
        { { IFS= read -r -d '' a0; IFS= read -r -d '' a1; } < "$d/cmdline"; } 2>/dev/null || true
        [ -n "${a0:-}" ] || continue
        is_node_argv0 "$a0" || continue
        { IFS= read -r -d '' cgline < "$d/cgroup"; } 2>/dev/null || true
        own=foreign
        case "$cgline" in
          *"/$RUN_CG_NAME") own=own ;;
        esac
        stat=""
        read -r stat < "$d/stat" 2>/dev/null || true
        rest="${stat#*) }"
        starttime=$(printf '%s\n' "$rest" | awk '{print $20}')
        echo "$pid $own ${starttime:-unknown} $a0 ${a1:-}"
      done
    } > "$CENSUS_OUT" 2>/dev/null
  fi
  FIRST=0

  sleep "$INTERVAL"
done
