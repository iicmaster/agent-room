---
title: 'The REL-3 pass rule — the requirements ruling and the pre-registration'
type: 'spec-amendment'
created: '2026-10-22'
status: 'ratified-by-the-release-owner'
baseline_revision: '3929cc74f30f1b0b1f5b989c6e9fbb9d4fed6eba'
---

# The REL-3 pass rule — the requirements ruling (2026-10-22)

**This is a dated amendment to `spec-6-2-rel-3-the-formal-soak.md`. It changes the MEASUREMENT, not
the promise.** It does not change a single packaged byte: `tests/soak/rel3-soak.mjs` and this document
are not among the packager's input lists (`scripts/package-release.mjs:45-46`:
`plugin.json`, `mcp.json`, `server/`, `web/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`), so
candidate `3929cc7` stays frozen and the REL-1 evidence stays bound to it.

## Why this amendment exists

Soak attempt 4 — the final candidate, the quiet host, 482.66 tracked minutes — FAILED one rule:
`final-window RSS growth above the 2% total-growth bound`. Everything else was green: zero message loss
(23,080 acknowledged == 23,080 readable, 0 duplicates, 0 lost), FD stability (worst drift 1 in a ±5
corridor), `candidate-exact` identity, and a host the telemetry proves was quiet (max 1-minute load 1.04,
min memAvailable 8.97 GiB). The FAIL is recorded under its own name in
`docs/release-evidence/v0.2.0-soak-attempts/attempt4-3929cc7.{json,md}`; it is never re-scored.

Two advisor lanes reviewed it (`docs/implementation/reviews/epic-6-soak-rss-final{,-claude}.md`) and
agreed on three things:

1. **The release is held.** The FAIL stands on the record; no door ships v0.2.0 on it.
2. **The rule, as placed, cannot distinguish retention from equilibration.** The profile ramps payloads
   linearly to the 32 KiB cap across the first half of the run and holds at the cap for the second, and
   the measured window IS that cap-hold: the rule therefore asks whether the process has stopped growing
   during the very hours it first carries its heaviest sustained load. The floor's hour-over-hour deltas
   decay (12.2 → 2.4 → 1.3 → 4.3 → 2.2 → 1.1 → 0.0 MiB), which is what approaching an asymptote looks
   like — and what a slowing leak would look like too. Only hours past the knee, or heap telemetry,
   discriminate.
3. **The amendment must be pre-registered, calibrated on traces that are not attempt 4's, and
   owner-ratified before any run under it qualifies.**

## The ruling (the release owner's, on the record)

**The promise is unchanged: the server's resident footprint must not grow.** The release keeps promising
resident-footprint stability (FR-13's "memory within the SM-3 noise band"); what changes is how that
promise is MEASURED. Concretely, three readings are settled:

**(i) The gate is FR-13's single band, and only that.** FR-13 (`prd.md:239`) reads: *"memory within
the SM-3 noise band (RSS least-squares slope over the final four hours ≤2% of starting RSS) — this band
is the single pass rule; no story may impose a stricter or looser memory criterion."* Story 6.2's AC
names the same thing ("RSS slope over the final four hours ≤2% of starting RSS (the single pass rule)").
The spec's implementation added a SECOND term — the endpoint growth — and that addition is exactly what
FR-13 forbids. **The endpoint term is therefore demoted to a reported diagnostic, not a criterion.** This
is a RESTORATION of the ratified rule, not a loosening of it: the ratified band (the least-squares slope)
stays the gate, and the demoted term was never ratified in the first place.

**(ii) The measured window is the final FOUR HOURS, not "the final half of the wall duration".** FR-13
says four hours; the spec's scaling (`finalWindowMs = durationMs / 2`) made the window grow with the
run, which is what put attempt 4's window exactly on the equilibration knee. The window is now
`min(4 h, half the run)` — at the default 8-hour duration that is unchanged (four hours), and for a
longer run it is four hours.

**(iii) The run is long enough for the window to sit past the knee, and the ramp is bounded so the
window is not the hold's start.** The profile's payload ramp is the first `min(4 h, half the run)`, the
cap-hold is the rest, and the qualifying run is **12 hours**: ramp 0–4 h, hold 4–12 h, measured window
8–12 h — four to eight hours into the cap-hold, where the 8-hour run's own floor deltas had already
reached 1.1 MiB and then 0.0 MiB.

**(iv) The retained-state diagnostic is collected, and its absence is inconclusive.** The server child is
launched with `--trace-gc` and the FULL GC event stream is persisted (the current capture keeps only a
rolling tail, which cannot support a post-collection statistic). The diagnostic is the trend in V8's used
heap immediately after confirmed natural major GCs, at comparable capped-load states, over the final
window. It is REPORTED, never gated: a replacement criterion needs its own baseline, window, denominator,
coverage requirement and missing-data outcome, and none is ratified yet. If the coverage is insufficient
the diagnostic reads INCONCLUSIVE — never PASS.

## What is NOT ratified, and what this amendment does not do

- It does not rescue attempt 4. Under the amended rule attempt 4 still FAILS: its slope-implied growth over
  its window is **+3.988%** against the 2% band. The demotion of the endpoint term changes nothing for
  it (the endpoint was 2.239%, also failing).
- It does not certify the server as leak-free. FR-13's band is a finite noise band, not a universal
  leak detector, and the calibration pins three of its limits as first-class rows: a persistent step at the
  tail of the window PASSES it, a growth rate just under the band is read differently depending on where
  the GC cycle sits in the window, and the retained-state diagnostic needs TEMPORAL coverage (a span), not
  a count of collections. What the next run can say is exactly this: **it met the registered RSS band and
  the other gates**, and the retained-state observation beside it is reported for what it is (the
  reachable V8 heap at confirmed natural major collections — it does not cover native or external
  allocations, and a flat used heap does not explain a rising RSS).
- It does not change the zero-message-loss or FD-stability criteria, the candidate, the package, the
  REL-1 evidence, or the release notes' claims about what the product promises.
- It does not introduce forced GC into qualification. Only NATURAL major collections are observed.

## The pre-registration (fixed before the next launch)

| Item | Fixed value |
|---|---|
| The statistic | the least-squares slope of the server's RSS over the final four hours, as a fraction of the window's starting RSS (FR-13's band) |
| The bound | ≤ 0.02 |
| The denominator | the first sample inside the measured window (`windowSamples[0].rssBytes`) |
| The window | the final four hours of the run (`min(4 h, half the run)`) |
| The run | 12 hours, ramp 0–4 h, cap-hold 4–12 h, window 8–12 h |
| The demoted term | the endpoint growth — REPORTED in the results, never gated |
| The retained-state diagnostic | the FITTED used-heap trend after confirmed natural major GCs in the window — REPORTED, never gated; the coverage requirement is temporal (the collections must span at least half the window and come from one load phase), not a count; inadequate coverage reads INCONCLUSIVE and never PASS; the observations (times and values) are retained with the verdict, and the raw GC trace is archived beside the results |
| The other gates | unchanged: zero message loss, FD stability after hour one, artifact stability, zero loop errors |
| The decision tree | **RSS PASS + every other gate PASS** → the story's evidence is qualified and the epic may close; the retained-state reading is reported beside it (flat = the reachable heap did not grow; rising = a finding to carry, NOT a leak-free claim; INCONCLUSIVE = no claim). **RSS PASS + any OTHER gate FAIL** (message loss, FD stability, artifact integrity, loop execution) → the run is a FAIL and the release is held on THAT gate; the retained-state reading does not rescue it. **RSS FAIL + the retained-state diagnostic RISING** → the server retains something reachable; the release is blocked on that, and the hunt uses heap snapshots. **RSS FAIL + the retained-state diagnostic FLAT** → the FAIL stands (a flat V8 heap does NOT refute a rising RSS: native allocations, allocator residency and continued equilibration are all still open); the hunt moves to native memory and allocator residency, not to the heap. **RSS FAIL + the retained-state diagnostic INCONCLUSIVE** → the FAIL stands and the observation is repeated. **Any INCONCLUSIVE observation** → no leak-free claim is made and no gate is turned into a PASS by it. **Interruption** (the run aborts) → the attempt is recorded under its own name as incomplete, exactly as attempt 3 was; it never qualifies and it is never re-scored. **A repeated INCONCLUSIVE observation** → it is a finding about the DIAGNOSTIC (its coverage requirement or the observation's collection), not about the server; the amendment is revisited once, not twice. |
| The calibration set | synthetic traces with injected growth around the bound, the archived runs replayed as DIAGNOSTICS (never attempt 4 as the fitting target), and three KNOWN LIMITATIONS pinned as first-class rows (a persistent tail step passes the band; the band is phase-sensitive near the bound; the diagnostic needs temporal coverage) |

## The owners' gate

Before the qualifying run: the amendment and this pre-registration go to a fresh advisor review, and the
run may not start until that review has returned. The review's job is to check that the statistic was
chosen because it detects real growth (not because it clears any run), that the calibration set contains
no attempt-4-fitted choice, and that the decision tree is complete enough that the night produces a
DECISION and not another review.
