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

## The quiet-host contract's correction (2026-10-22, before any measured window opened)

The contract above was first written as: "the maximum 1-minute load ≤ 2.0, the minimum MemAvailable
≥ 4 GiB, and **no node process other than the run's own server, its four clients and the recorder**".
Two of its three clauses were mis-specified, and the reason is measurable rather than a matter of
opinion:

- **The process clause could never be satisfied on this host.** The baseline census pins FOUR
  long-lived node services of its own under the observer's definition (a model gateway, two MCP
  servers, and the codex app-server); under a wider definition — every process whose EXECUTABLE is a
  node binary — there are seven, because the MCP servers' npm wrappers and a Next.js server are node
  processes that have renamed their argv[0]. Either way they were present during EVERY attempt,
  including attempt 4, which ran on this same host. A criterion that can never be satisfied
  disqualifies every attempt equally: it measures the HOST, not the run.
- **The load clause measures the run's own I/O, not a neighbour's.** With the run in flight the
  host's CPU was over 90% idle while the 1-minute load sat between 1.2 and 1.9 and spiked to 3.2 —
  the load average counts the run's own fsync waits (the store commits with `synchronous=FULL`).
  Gating on it would have failed the run for doing its job.

The corrected contract (above) measures the host's FOREIGN state — the processes and the CPU that
are not the run's — which is what "a quiet host" was always meant to mean, and which catches the
contention that actually happened in attempt 2 (a full suite run adds ten or more node children and
consumes CPU and memory: the node-process count and the foreign CPU share both move).

**This correction was made while a run was in flight, and before its measured window opened.** That
is recorded here rather than smoothed over, and it was made on a MEASUREMENT (the clause is
unsatisfiable on this host; the load is the run's own I/O) rather than on the run's OUTCOME — the
run's memory verdict was not yet known and is not changed by this correction. The MEMORY RULE ITSELF
(the gate the run is judged by) is untouched. A fresh advisor review of the corrected contract stands
between this correction and the next run: `docs/implementation/reviews/epic-6-quiet-host-contract-*.md`.

### What the advisor gate found, and what was done about it (2026-10-22)

BOTH lanes reviewed the corrected contract — codex `gpt-6.1-sol[ultra]` and claude `claude-fable-5`
(the agy seat was quota-exhausted, so the second voice was the claude lane, and the substitution is
recorded rather than smoothed over). They agreed on the CORRECTION — the timing, the basis, the cost
of a voided night, and the fact that a CONFOUNDED window can only void a night, never manufacture a
PASS — and they converged on the same two defects in the INSTRUMENT the contract names as its sole
source, both of which would have marked every window CONFOUNDED:

1. **The busy-CPU arithmetic counted idle and iowait as consumption.** The observer summed
   user+nice+system+**idle**+**iowait**+irq+softirq, so the foreign CPU of an entirely idle
   four-core host read 4.000 cores. Both lanes reproduced it deterministically from a fixture. The
   observer now sums the BUSY fields only (user+nice+system+irq+softirq), reports `steal` separately
   rather than folding lost VM capacity into ordinary process CPU, and the self-check recomputes the
   observer's arithmetic from its own log.
2. **The run's own CPU was summed over the processes that happened to be alive.** The harness closes
   and respawns its four clients at every hourly reconnect, so subtracting successive sums of
   lifetime counters produced a large NEGATIVE run delta the moment a client exited — a spurious
   multi-core "foreign" spike once an hour, inside the measured window. The run's own CPU is now the
   CGROUP's `cpu.stat` usage, which is monotonic and survives process exit by construction, and the
   run's own IDENTITY is its cgroup's membership — so nothing is classified by a substring of its
   command line (the previous rule accepted any command line merely mentioning the soak's script).

Three further findings were closed as well: the observer now moves itself into its own cgroup and
excludes its own CPU from the residual, so it cannot inflate the number it reports; the per-minute
sample is fork-free (no `readlink` per host process), so the observer is not the load it measures;
and the baseline is now MEASURED with the same observer on the same host and PINNED by identity —
executable, arguments, start time and boot id — instead of being a number in prose.

### The second unsatisfiability, and what it did to the CPU thresholds

With a correct observer, the host's own behaviour showed up plainly: **ngs-staging is not a quiet
host, and cannot be one.** It runs a Laravel application (horizon workers, an artisan scheduler, a
reverb socket), a Next.js site, a model gateway, two MCP servers, a Docker daemon — and a systemd
timer that checks a staging auto-deploy EVERY MINUTE, whose builds compile PHP (a `cc1` at ~90% of a
core) and drive the host's busy time between roughly 0.2 and 4.0 cores. An ABSOLUTE foreign-CPU
threshold (the mean ≤ 0.25 cores that was first drafted) is therefore as unsatisfiable as the
original process clause — the same F18 lesson, one clause further on.

So (c) is relative to the MEASURED baseline, the way (b) already was: the window's foreign CPU is
compared with the same measure taken over the baseline window on the same host, with a stated
allowance. The thresholds are FROZEN in `docs/implementation/rel3-quiet-host-thresholds.json` before
the run and are never adjusted afterwards. The memory gate is untouched by any of this.

### The scorer, and the missing-data disposition

The amendment's outcome shape ("a breach is CONFOUNDED → incomplete, never scored") had no
implementation: it was an awk nobody had pre-registered, and the clause the gate depends on lived
only in a review brief. `scripts/rel3-soak-eligibility.mjs` is that scorer: it reads the FROZEN
thresholds file and the observer's log and returns ELIGIBLE, CONFOUNDED or INCOMPLETE, with its
reasons. It does not judge the soak, and an ELIGIBLE verdict does not confer a PASS — it only
permits the unchanged memory and other gates to be scored. **Missing, gapped or invalid telemetry is
INCOMPLETE** — it is never read as a quiet host, and an attempt with no telemetry is never scored.

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
| The retained-state diagnostic | the FITTED used-heap trend after confirmed natural major GCs in the window — REPORTED, never gated, and its classification threshold is PROVISIONAL (no prior run collected a `--trace-gc`, so the first 12-hour trace IS this diagnostic's first calibration data: its first classification is a reported observation with an uncalibrated threshold, not a vetted instrument); the coverage requirement is temporal (the collections must span at least half the window and come from one load phase), not a count; inadequate coverage reads INCONCLUSIVE and never PASS; the observations (times and values) are retained with the verdict, and the raw GC trace is archived beside the results |
| The other gates | unchanged: zero message loss, FD stability after hour one, artifact stability, zero loop errors |
| The decision tree | **CONFOUNDED (the telemetry breaches the quiet-host thresholds inside the window)** → the attempt is recorded under its own name as incomplete, never scored, never re-scored — the same shape as an interruption. **RSS PASS + every other gate PASS** → the story's evidence is qualified and the epic may close; the retained-state reading is reported beside it (flat = the reachable heap did not grow; rising = a finding to carry, NOT a leak-free claim; INCONCLUSIVE = no claim). **RSS PASS + any OTHER gate FAIL** (message loss, FD stability, artifact integrity, loop execution) → the run is a FAIL and the release is held on THAT gate; the retained-state reading does not rescue it. **RSS FAIL + the retained-state diagnostic RISING** → the server retains something reachable; the release is blocked on that, and the hunt uses heap snapshots. **RSS FAIL + the retained-state diagnostic FLAT** → the FAIL stands (a flat V8 heap does NOT refute a rising RSS: native allocations, allocator residency and continued equilibration are all still open); the hunt moves to native memory and allocator residency, not to the heap. **RSS FAIL + the retained-state diagnostic INCONCLUSIVE** → the FAIL stands and the observation is repeated. **Any INCONCLUSIVE observation** → no leak-free claim is made and no gate is turned into a PASS by it. **Interruption** (the run aborts) → the attempt is recorded under its own name as incomplete, exactly as attempt 3 was; it never qualifies and it is never re-scored. **A repeated INCONCLUSIVE observation** → it is a finding about the DIAGNOSTIC (its coverage requirement or the observation's collection), not about the server; the amendment is revisited once, not twice. |
| The quiet-host contract | the SOURCE is `scripts/rel1-soak-telemetry.sh` — the repository's own read-only observer, which measures the HOST and nothing else, and whose arithmetic is VERIFIED by `scripts/rel1-soak-telemetry-check.sh` (the self-check: the observer's arithmetic recomputed from its own log, an independent measurement of the host's busy time, a foreign load counted, an equivalent run-owned load excluded, a process exit without a spike, and the identity fixtures). The THRESHOLDS are not written here: they are FROZEN in `docs/implementation/rel3-quiet-host-thresholds.json`, registered before the run and never adjusted afterwards, and `scripts/rel3-soak-eligibility.mjs` reads THAT file — so the contract and the scorer cannot drift apart. In outline, the measured window (the final four hours, the same four hours the memory gate uses) is judged on: **(a)** the minimum MemAvailable ≥ 4 GiB; **(b)** the maximum FOREIGN node-process count ≤ the **MEASURED** baseline + 3; **(c)** the FOREIGN CPU in CORES, in the two shapes that GATE: the window **MEDIAN** (nearest-rank) and the window **MEAN**, the mean weighted by each interval's ELAPSED TIME. The nearest-rank p95, the maximum, the worst rolling five-minute mean and the count of minutes above one core are REPORTED and never gated — this host's own PHP-build bursts reach ~2 cores, so gating a tail statistic against a baseline that may not contain a burst would void a clean night for the host's own behaviour. The LIMITS are the ABSOLUTE numbers registered in `docs/implementation/rel3-quiet-host-thresholds.json` — derived from a measurement of this host, frozen there, and never recomputed from whatever files an operator hands the scorer: the baseline is a CROSS-CHECK, not the source of the limits; **(d)** the LOAD AVERAGE REPORTED, never gated. The BASELINE is measured on the same host, with the same observer, in the window before the run begins, and the foreign processes are PINNED by identity (executable, arguments, start time, boot id) in the baseline census — a baseline that is only a number in prose is not a baseline. The baseline's statistics EXCLUDE the observer's first sample, which has no previous sample to difference against and is therefore a synthetic zero rather than a measurement. The thresholds file, the observer, the self-check, the scorer and the launch script are pinned by SHA-256 in the attempt's launch record, and the scorer refuses a thresholds file whose digest is not the one the launch recorded: **frozen means committed and digested, not a working tree.** The OUTCOME SHAPE: a window that breaches (a), (b) or (c) is **CONFOUNDED → the attempt is recorded under its own name as incomplete, never scored, and never re-scored** — exactly the interruption branch. It is not a FAIL, and it is not a PASS. And **MISSING or INVALID telemetry is INCOMPLETE** — it is never read as a quiet host. A valid host window permits the unchanged memory and other gates to be scored; it does not itself confer a PASS. |
| The identity verdict | a `runtime-pinned-docs-drift` identity (the packaged EXECUTING inputs are byte-identical to the candidate but the docs moved) does NOT qualify a run: every archived run was `candidate-exact`, and the qualification requires `candidate-exact`. A docs-drift run is recorded as incomplete, like a confounded one. |
| The calibration set | synthetic traces with injected growth around the bound, the archived runs replayed as DIAGNOSTICS (never attempt 4 as the fitting target), and FOUR KNOWN LIMITATIONS pinned as first-class rows (a persistent tail step passes the band; the band is phase-sensitive near the bound; a DECELERATING leak looks like equilibration and passes; the diagnostic needs temporal coverage) — plus the phase sweep replayed on attempt 1's OWN residuals, the run that PASSED, where the band holds at every phase (it is robust when there is headroom) |

## The owners' gate

Before the qualifying run: the amendment and this pre-registration go to a fresh advisor review, and the
run may not start until that review has returned. The review's job is to check that the statistic was
chosen because it detects real growth (not because it clears any run), that the calibration set contains
no attempt-4-fitted choice, and that the decision tree is complete enough that the night produces a
DECISION and not another review.
