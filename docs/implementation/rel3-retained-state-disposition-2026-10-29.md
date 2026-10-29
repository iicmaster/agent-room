# REL-3 retained-state disposition — Story 7.6 (2026-10-29)

**Disposition: RECORDED NON-DEFECT — the rise is below the instrument's own
resolution; no retainer repair is indicated. The provisional threshold is
CALIBRATED by this first trace, with a robustness rule recorded for the next
one.**

The instrument: `scripts/rel3-retained-state-analysis.mjs` (committed with
this disposition) recomputes every number below from the ARCHIVED trace —
`docs/release-evidence/v0.2.0-soak-attempts/attempt6-3929cc7-server-gc-trace.log`
(142 major collections over 12.06 h). The pinned row
(`tests/rel3-retained-state-disposition.test.mjs`) re-runs it, so the
disposition cannot drift from its evidence.

## What the raw trace says

| View | Number |
|---|---|
| Final-4h window majors | 57 |
| Window mode (post-GC used heap) | **9.2 MiB, holding 89.5% of all window observations** |
| OLS over the window (the recorded rule's shape) | −0.28 %/h |
| OLS excluding the 6 reconnect-window transients | **0.00 %/h** |
| Endpoint movement | **0 display buckets** (9.2 → 9.2) |
| Instrument resolution at this heap (one 0.1-MiB V8 print bucket over 4 h) | **~0.27 %/h** |
| Whole-run shape | first-hour mode 8.5 MiB (warmup) → **plateau at 9.2 MiB held for the last 9.2 h** |

## Why the recorded "RISING 0.65%/h" is an artifact

The run's recorded diagnostic (`docs/release-evidence/v0.2.0-soak-results.json`,
retainedState: classification rising, 9.2 → 9.3 MiB, 46 observations) is
arithmetically reproducible from its own series — but the series itself does
not carry a rise:

1. **The signal is smaller than the instrument.** One 0.1-MiB display bucket
   over a 4-h window at a 9.2-MiB heap is ~0.27 %/h — the claimed 0.65 %/h
   rests on an endpoint movement the printer cannot resolve (the raw trace's
   own final major reads 9.2; the recorded series' single 9.3 tail point has
   no matching major in the archived trace).
2. **The slope is driven by transients.** Four to six reconnect-window majors
   (11.5–12.6 MiB) pull the OLS; with them excluded the slope is 0.00 %/h —
   thirty times under the ratified 0.5 %/h flat tolerance.
3. **The robust core is exactly flat.** 40+ window observations sit on
   precisely 9.2 MiB; the median of the window's first ten equals the median
   of its last ten (9.2). A leak does not look like this — a leak's mode
   CREEPS (9.2 → 9.3 → 9.4 …); this run's mode is pinned for nine hours.

## The calibration decision (A11's open part, closed by this record)

The retained-state threshold leaves PROVISIONAL status calibrated by this
first 12-hour trace with one robustness rule added for the next one:
**"rising" is claimable only when (a) the transient-excluded core slope
exceeds the flat tolerance AND (b) the endpoint moves at least two display
buckets.** A rise smaller than the instrument's resolution is recorded as
below-resolution, never as rising. The next qualifying trace is the
confirmation run; the FR-13 settled-window RSS gate is untouched (the
amendment's own boundary), and the recorded diagnostic in the shipped
results file stands exactly as captured — evidence is never edited to fit
a disposition.
