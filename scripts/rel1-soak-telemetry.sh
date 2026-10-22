#!/usr/bin/env bash
# The REL-3 soak's host-telemetry sidecar (Story 6.2; the 2026-10-22
# requirements ruling). It is a READ-ONLY observer of the HOST: it touches no
# repository code, changes no gate, and writes one line a minute beside the run.
#
# WHY IT EXISTS. A soak's memory verdict is only as good as the host it ran on:
# a neighbour's workload on the same machine changes what the server's RSS
# does. The sidecar exists so that question is ANSWERED BY MEASUREMENT rather
# than asserted — and so the answer is comparable across attempts (the same
# fields, the same cadence, the same file format).
#
# WHAT IT MEASURES, per sample:
#   load           the 1/5/15-minute load averages
#   memAvailable   the host's available memory (kB)
#   nodeProcs      the host's node process count (total)
#   ownProcs       the node processes that belong to THIS run
#   foreignProcs   the node processes that are NOT the run's own
#   foreignCores   the host's CPU consumed by processes OTHER than the run's own,
#                  expressed in CORES (1.000 = one core saturated)
#   serverRss_kB   the run's server child's RSS
#   pgmajfault     the host's major-fault counter
#
# The FOREIGN figures are the point: this host carries long-lived services of
# its own (a model gateway and two MCP servers), so "no node process other than
# the run's" can never be true here — and a criterion that can never be
# satisfied disqualifies every attempt equally, which measures the host, not the
# run. The sidecar therefore separates the run's own footprint from the host's
# baseline, and the quiet-host contract is written against THAT difference.
#
# THE OBSERVER MUST NOT BE A WORKLOAD. An observer that loads the machine
# corrupts what it measures, so this script does the least work it can: one
# pass over /proc per minute (a readlink per process to recognise a node
# binary, a command line read only for the ones that are), no subprocess per
# process, no subprocess per sample beyond a handful of awk calls, and a one
# minute sleep between samples.
#
# Usage: rel1-soak-telemetry.sh <out-file> <server-pid> [world-path]
set -u

OUT="${1:?usage: rel1-soak-telemetry.sh <out-file> <server-pid> [world-path]}"
# NB: no apostrophe may appear inside a ${...?word} expansion — the word is
# subject to quote removal, so an unmatched quote there breaks the lexer.
SERVER_PID="${2:?the server child pid}"
WORLD="${3:-}"

if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then
  echo "rel1-soak-telemetry: this observer needs a Linux /proc (found none)" >&2
  exit 2
fi

CLK_TCK=$(getconf CLK_TCK 2>/dev/null || echo 100)

# Is this command line one of the RUN's own? The run's processes are the soak
# runner (named by the script it runs), the server, its clients and the
# recorder — all of which name the run's world directory — so two plain
# substrings identify them. They are matched as STRINGS, never as regular
# expressions, and no subprocess is spawned to do it.
is_run_own() {
  local cmd="$1"
  case "$cmd" in
    *"rel3-soak.mjs"*) return 0 ;;
  esac
  if [ -n "$WORLD" ]; then
    case "$cmd" in *"$WORLD"*) return 0 ;; esac
  fi
  return 1
}

# The command line of a pid, with NULs turned into spaces. A pid that exits
# between the directory listing and the read yields an empty string, not an
# error.
cmdline_of() {
  { tr '\0' ' ' < "/proc/$1/cmdline"; } 2>/dev/null || true
}

# The host's CPU, in jiffies, from /proc/stat.
host_cpu_total() {
  awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8}' /proc/stat
}

# utime+stime of a pid, in jiffies. The comm field may contain spaces and
# parentheses, so the line is cut after the LAST ')'.
cpu_jiffies_of() {
  local rest fields
  rest=$(sed -e 's/^.*) //' "/proc/$1/stat" 2>/dev/null) || return 0
  [ -n "$rest" ] || return 0
  # After the comm field: state is 1, utime is 12, stime is 13.
  fields=$(printf '%s\n' "$rest" | awk '{print $12+$13}')
  printf '%s' "${fields:-0}"
}

PREV_CPU_TOTAL=""
PREV_RUN_CPU=0
PREV_TS=0

while true; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  NOW=$(date -u +%s)
  LOAD=$(awk '{print $1" "$2" "$3}' /proc/loadavg 2>/dev/null || true)
  FREE=$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
  MAJ=$(awk '/pgmajfault/{print $2}' /proc/vmstat 2>/dev/null || echo 0)

  # One pass over the process table: recognise the node binaries by their
  # executable (not by their command line, which would match any path that
  # merely contains the letters "node"), then classify each one.
  OWN_PROCS=0
  FOREIGN_PROCS=0
  RUN_CPU=0
  for dir in /proc/[0-9]*; do
    pid="${dir#/proc/}"
    exe=$(readlink -f "$dir/exe" 2>/dev/null || true)
    exe="${exe% (deleted)}"   # a replaced binary reads back as "node (deleted)"
    case "${exe##*/}" in
      node|node[0-9]*) ;;
      *) continue ;;
    esac
    cmd=$(cmdline_of "$pid")
    if is_run_own "$cmd"; then
      OWN_PROCS=$(( OWN_PROCS + 1 ))
      RUN_CPU=$(( RUN_CPU + $(cpu_jiffies_of "$pid") ))
    else
      FOREIGN_PROCS=$(( FOREIGN_PROCS + 1 ))
    fi
  done
  NODE_PROCS=$(( OWN_PROCS + FOREIGN_PROCS ))

  RSS=0
  if [ -r "/proc/$SERVER_PID/status" ]; then
    RSS=$(awk '/VmRSS/{print $2}' "/proc/$SERVER_PID/status" 2>/dev/null || echo 0)
  fi

  CPU_TOTAL=$(host_cpu_total)

  # The host's foreign CPU: the aggregate delta minus the run's own delta,
  # expressed in cores (1.000 = one core saturated).
  FOREIGN_CORES=0.000
  if [ -n "$PREV_CPU_TOTAL" ] && [ "$NOW" -gt "$PREV_TS" ]; then
    HOST_DELTA=$(( CPU_TOTAL - PREV_CPU_TOTAL ))
    RUN_DELTA=$(( RUN_CPU - PREV_RUN_CPU ))
    FOREIGN_DELTA=$(( HOST_DELTA - RUN_DELTA ))
    [ "$FOREIGN_DELTA" -lt 0 ] && FOREIGN_DELTA=0
    FOREIGN_CORES=$(awk -v d="$FOREIGN_DELTA" -v s="$CLK_TCK" -v secs="$(( NOW - PREV_TS ))" \
      'BEGIN{printf "%.3f", d/(s*secs)}')
  fi
  PREV_CPU_TOTAL="$CPU_TOTAL"
  PREV_RUN_CPU="$RUN_CPU"
  PREV_TS="$NOW"

  echo "$TS load=$LOAD memAvailable_kB=$FREE nodeProcs=$NODE_PROCS ownProcs=$OWN_PROCS foreignProcs=$FOREIGN_PROCS foreignCores=$FOREIGN_CORES serverRss_kB=$RSS pgmajfault=$MAJ" >> "$OUT"
  sleep 60
done
