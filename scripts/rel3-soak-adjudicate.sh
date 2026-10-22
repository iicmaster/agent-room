#!/usr/bin/env bash
# Adjudicate a finished REL-3 soak attempt: score the host window against the
# FROZEN quiet-host contract, and bring the attempt's own evidence into the
# repository under ITS OWN NAME.
#
# WHAT IT DOES AND DOES NOT DO. It produces the eligibility verdict (ELIGIBLE /
# CONFOUNDED / INCOMPLETE) and archives the attempt's evidence. It does NOT
# decide the release, and it does NOT touch the release evidence
# (`docs/release-evidence/v0.2.0-soak-results.{json,md}`) — that copy is a
# deliberate, separate step, taken by a human reading the verdict. An attempt
# is never relabelled: its files keep its name whatever the verdict says.
#
# USAGE: rel3-soak-adjudicate.sh <repo-dir> <parent-dir> <attempt-name>
set -u

REPO="${1:?usage: rel3-soak-adjudicate.sh <repo-dir> <parent-dir> <attempt-name>}"
PARENT="${2:?usage: rel3-soak-adjudicate.sh <repo-dir> <parent-dir> <attempt-name>}"
ATTEMPT="${3:?usage: rel3-soak-adjudicate.sh <repo-dir> <parent-dir> <attempt-name>}"

WORLD="$PARENT/.soak-world"
EVIDENCE="$WORLD/evidence"
TELEMETRY="$PARENT/telemetry.log"
RESULTS="$EVIDENCE/v0.2.0-soak-results.json"
RESULTS_MD="$EVIDENCE/v0.2.0-soak-results.md"
SOAK_LOG="$WORLD/soak.log"
RECORD="$PARENT/launch-record.txt"
SCORER="$REPO/scripts/rel3-soak-eligibility.mjs"
THRESHOLDS="$REPO/docs/implementation/rel3-quiet-host-thresholds.json"
ARCHIVE="$REPO/docs/release-evidence/v0.2.0-soak-attempts"

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

for required in "$RESULTS" "$TELEMETRY" "$SOAK_LOG" "$RECORD"; do
  if [ ! -r "$required" ]; then
    echo "rel3-soak-adjudicate: $required is missing or unreadable" >&2
    exit 2
  fi
done

mkdir -p "$ARCHIVE"

# --- the window's bounds, from the RUN'S OWN record -------------------------------------
# The host window must be the SAME four hours the memory gate used. The
# harness's final-window rule anchors to the LAST TRACKER SAMPLE (the tracker
# stops before the final drain), so the window's end is that sample's
# instant, not the run's endedAt — which is later, by the drain.
RUN_START=$(python3 -c "
import json
print(json.load(open('$RESULTS')).get('startedAt', ''))
")
WINDOW_END=$(python3 -c "
import json, datetime
d = json.load(open('$RESULTS'))
samples = (d.get('samples') or {}).get('data') or []
if not samples:
    raise SystemExit(1)
print(datetime.datetime.fromtimestamp(samples[-1]['atMs'] / 1000, datetime.timezone.utc).isoformat().replace('+00:00', 'Z'))
")
RUN_END=$(sed -n 's/^\([0-9T:Z.-]\{24\}\) REL-3 soak finished with status.*/\1/p' "$SOAK_LOG" | head -1)
if [ -z "$RUN_START" ] || [ -z "$WINDOW_END" ]; then
  echo "rel3-soak-adjudicate: the run's start or the window's end could not be read from $RESULTS" >&2
  exit 3
fi

# --- the adjudication --------------------------------------------------------------------
# The thresholds digest the LAUNCH recorded is the one the scorer must see:
# a thresholds file that changed between the launch and the scoring is a
# different rule, and the scorer refuses it.
EXPECTED_DIGEST=$(grep '^thresholds_digest ' "$RECORD" | head -1 | cut -d' ' -f2)
ELIGIBILITY="$ARCHIVE/$ATTEMPT-eligibility.json"

# The EXTRA baseline source is an EARLIER measurement of the same host, not
# the run's own log: the run's log contains the run's samples, and a baseline
# source that carries samples from after the run's start is an invalid source
# (the scorer refuses it, correctly).
EXTRA_BASELINE="$REPO/docs/release-evidence/v0.2.0-quiet-host/host-baseline-2026-10-22.log"

node "$SCORER" \
  --telemetry "$TELEMETRY" \
  ${EXTRA_BASELINE:+--baseline-extra "$EXTRA_BASELINE"} \
  --run-start "$RUN_START" \
  --run-end "$WINDOW_END" \
  --thresholds "$THRESHOLDS" \
  ${EXPECTED_DIGEST:+--expect-thresholds-digest "$EXPECTED_DIGEST"} \
  --out "$ELIGIBILITY"
SCORER_EXIT=$?

# --- the attempt's own evidence, under its own name ---------------------------------------
cp "$RESULTS" "$ARCHIVE/$ATTEMPT.json"
cp "$RESULTS_MD" "$ARCHIVE/$ATTEMPT.md"
cp "$TELEMETRY" "$ARCHIVE/$ATTEMPT-telemetry.log"
cp "$SOAK_LOG" "$ARCHIVE/$ATTEMPT-soak.log"
cp "$RECORD" "$ARCHIVE/$ATTEMPT-launch-record.txt"
cp "$PARENT/baseline-census.txt" "$ARCHIVE/$ATTEMPT-census.txt" 2>/dev/null || true

VERDICT=$(python3 -c "
import json
try:
    print(json.load(open('$ELIGIBILITY')).get('verdict', 'unknown'))
except Exception:
    print('unreadable')
")
{
  echo "# $ATTEMPT"
  echo "adjudicated_at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "run_start $RUN_START"
  echo "run_end $RUN_END"
  echo "window_end $WINDOW_END"
  echo "window_note the window's end is the LAST TRACKER SAMPLE, the instant the harness's final-window RSS rule anchors to; the run's endedAt is later, by the final drain"
  echo "thresholds_digest_at_launch ${EXPECTED_DIGEST:-none}"
  echo "thresholds_digest_at_scoring sha256:$(digest "$THRESHOLDS")"
  echo "scorer_exit $SCORER_EXIT"
  echo "eligibility_verdict $VERDICT"
  echo "note the release evidence (docs/release-evidence/v0.2.0-soak-results.{json,md}) is NOT touched by this step; it is a separate, deliberate step taken after the verdict is read"
} > "$ARCHIVE/$ATTEMPT-adjudication.txt"

echo "verdict $VERDICT"
echo "eligibility $ELIGIBILITY"
echo "archived under $ARCHIVE/$ATTEMPT.*"
exit 0
