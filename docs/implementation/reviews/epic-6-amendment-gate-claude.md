# Round-Table: the owners' gate on the amended REL-3 rule (`epic-6-amendment-gate-claude2`)

**Verdict in one line:** the amendment is honest — the statistic is FR-13's own ratified band, chosen
from the PRD's text and failing attempt 4 twice over (0.03988 and, as the demoted report, 0.02239
against 0.02), with the fitting-guard asserted in the calibration itself — and the run may start **after
two preconditions**: (1) pre-register the quiet-host contract (telemetry source, thresholds, and the
"confounded → incomplete, never scored" outcome shape), which is the one shape the decision tree does
not cover and exactly the shape attempt 2 already taught; (2) remove `Scavenge (reduce)` from the
major-GC parser (one line, `tests/soak/rel3-soak.mjs:1122`) — a scavenge is a young-generation
collection and its post-GC used heap is not the reachable set, so the current pattern can both inflate
the diagnostic's coverage count and contaminate its trend. Everything else found is a pin-it-don't-block
item.

Task: epic-6-amendment-gate-claude2. Advisory only; no soak, code edit, gate change, candidate change,
or release action was performed. The sole authored file is this outbox.

## Pre-table fact check (read and re-run, not taken from the brief)

1. **The calibration suite passes and is STRONGER than the brief says.** `node --test
   tests/soak/rel3-soak-calibration.test.mjs` → **10 pass / 0 fail**, not 7: commit `ca63859` added
   three KNOWN LIMITATION rows (persistent tail step passes; phase sensitivity near the bound at
   0.55%/hr; temporal coverage, not a count) after the brief was written. All three pin exactly the
   limits my previous verdict and the owners'-gate charter demanded be first-class.
2. **The attempt-4 fitting guard is real and self-enforcing.** The suite replays the stored samples of
   attempts 1, 2 and 4 through the REAL exported evaluator (not a copy) and asserts attempt 4 still
   FAILS with `impliedGrowthRatio > 0.02` (`rel3-soak-calibration.test.mjs:197-222`). If a future edit
   ever fits the rule to attempt 4, this test goes red.
3. **The gate wiring matches the pre-registration.** `evaluateFinalWindowRss` gates on
   `impliedGrowthRatio` only; the endpoint term lives in `reportedOnly` (`rel3-soak.mjs:1044-1051`).
   The final verdict requires RSS + FD + zero-loss + artifact stability + no fatal + **zero loop
   errors** (`rel3-soak.mjs:1683-1690`) — the "other gates unchanged" row is implemented, not just
   written.
4. **The schedule matches the ruling.** `deriveSchedule`: `finalWindowMs = min(4 h, half the run)`,
   `rampMs = min(4 h, half the run)` (`rel3-soak.mjs:307-310`); a 12-hour run ramps 0–4 h, holds
   4–12 h, measures 8–12 h; the 8-hour default is bit-identical to before. Reconnects stay hourly
   (capped at 1 h). One drift: `fdBaselineAfterMs = durationMs/8` is NOT capped, so at 12 hours the FD
   baseline is **90 minutes**, not the AC's "after hour one" — mildly looser, see Q4.
5. **The diagnostic's ordering is sound.** The GC trace is read after `tracker.stop()` and the window
   is anchored at the last tracker sample (`rel3-soak.mjs:1666-1671`, `1129-1138`), so the drain's own
   GC churn cannot land inside the window; the raw trace is captured in full (not the rolling tail)
   and archived beside the results; the REL-4 final idle sample now settles 60 s
   (`rel3-soak.mjs:1656-1662`).
6. **Paths corrected:** the brief cites `docs/implementation/reviews/epic-6-soak-rss-final{,-claude}.md`;
   those files do not exist. The prior verdicts live in `.mailbox-out/epic-6-soak-rss-final` and
   `.mailbox-out/epic-6-soak-rss-final-claude` (the claude verdict's fact check and bottom lines and
   the codex verdict's bottom lines were re-read here, not either file end-to-end; every demand found in
   them maps to a row of the amendment except the host-contention shape — the gap named below).
7. **FR-13 verified at source** (`prd.md:239`): "RSS least-squares slope over the final four hours ≤2%
   of starting RSS) — this band is the single pass rule; no story may impose a stricter or looser
   memory criterion" — the amendment quotes it faithfully. Note the same line opens with "The 8-hour
   soak protocol (SM-3)": the EIGHT hours is FR-13's own text, so the 12-hour run is a deviation from
   it ratified via the epics amendment (`docs/epics.md:590`), which is exactly Grumbal's point below.

At the table (continuity with the attempt-2 and attempt-4 reviews): **John** (PM), **Dr Mira**
(measurement/statistics), **Winston** (runtime architecture), **Grumbal** (qualification assurance),
**Sally** (operator experience).

---

## Q1 — Is the amendment honest?

📐 **Dr Mira:** "I came looking for a statistic chosen to clear attempt 4, and I did not find one. The
statistic is the one sentence FR-13 ratified before any soak ran (`prd.md:239` — the least-squares
slope over the final four hours, ≤2% of starting RSS); the thing that was REMOVED is the unratified
second term; and the run the amendment was written after fails the amended rule by a factor of two.
The calibration asserts that fact as a test, so it cannot silently rot. The rows I demanded in the
attempt-2 review are all here: injected growth around the bound (1%/hr fails, 0.2%/hr passes), stability
at every phase, the window anchored by text rather than by what passes. This is what pre-registration
is supposed to look like."

😤 **Grumbal:** "Say the other half, Mira. The STATISTIC is honest — but the statistic was never the
thing that would turn the next run green. The **12-hour run with the window at hours 8–12** is. That
design element is AGAINST FR-13's own letter — `prd.md:239` opens 'The 8-hour soak protocol (SM-3)',
so twelve hours needed (and got) its own epics amendment (`docs/epics.md:590`) — and it was
chosen precisely because attempt 4's window sat on the equilibration knee. After three red runs, the
one knob that changes the expected outcome is the knob they turned."

🏗️ **Winston:** "And that is why it is still honest, Grumbal: the knob they turned is also the only
knob that DISCRIMINATES. If the server equilibrates, hours 8–12 are flat and it passes; if it retains
~300 bytes per message, hours 8–12 keep climbing at the same message rate and it fails — my own
bottom line last review said exactly that flip condition. A dishonest amendment removes the run's
ability to fail; this one moves the measurement to where failure would finally mean something. Add
that the window move is a RESTORATION of FR-13's literal four hours against the spec's own
half-the-run drift, and I have no charge to press."

📐 **Dr Mira:** "Two controls are missing, though, and I want them named rather than discovered.
First: there is **no decelerating-growth row**. A leak whose rate decays — logarithmic, 1/t — looks
exactly like equilibration at hours 8–12 and passes; the tail-step limitation pins a step, not a decay.
That should be the fourth KNOWN LIMITATION row: *the band at hours 8–12 cannot distinguish a decaying
leak from equilibration*. Pin it; do not block on it — no four-hour band can make that distinction,
which is why the retained-state diagnostic exists. Second: the `sawtoothTrace` noise model (7 MiB
amplitude, one 25-minute cycle) is **gentler than the archived traces** — the agy review counted
10-minute burst jumps of 8–27 MiB on top of a 60-minute reconnect period. Phase sensitivity near the
bound scales with amplitude, so the 0.55%/hr row likely understates the real phase lottery. The right
follow-up is to replay the phase rows on attempt 1's window residuals — the PASS run, so it is not
fitting to the run under dispute."

😤 **Grumbal:** "I accept 'honest' with Mira's two rows pinned. I do not withdraw the observation that
the run design is outcome-selected — I record that its saving grace is falsifiability, and I will be
watching hours 8–12 for exactly the still-climbing floor Winston described."

## Q2 — Is the retained-state diagnostic adequate as REPORTED-only?

🏗️ **Winston:** "The architecture is right: full `--trace-gc` capture to a file (the rolling tail
cannot support a statistic — fixed), natural collections only, a FITTED trend rather than endpoints
(the excursion test proves 40→80→90→40 cannot read 'flat'), temporal coverage (span ≥ half the window,
one load phase) rather than a bare count, INCONCLUSIVE-never-PASS as the missing-data outcome, raw
trace archived beside the verdict. And REPORTED-only is correct: a V8-heap criterion has no ratified
baseline, and a flat used heap genuinely does not refute a rising RSS — native allocations and
allocator residency are invisible to it. The code says all of this about itself.

But there is a **defect in the parser**: the major-collection alternation at `rel3-soak.mjs:1122`
includes `Scavenge (reduce)`. Any scavenge — reduce or not — collects the young generation only; the
used heap after it still carries uncollected old-generation garbage, so it is NOT the reachable set
the header promises ('confirmed natural major collections'). Including it inflates the coverage count
(making INCONCLUSIVE less likely than it should be) and contaminates the fitted trend with
systematically higher readings. The parser test (`rel3-soak-calibration.test.mjs:254-266`) only checks
that a plain `Scavenge` line is excluded, so it cannot catch this. One-line fix plus one test line."

😤 **Grumbal:** "And that fix is a BLOCKER. The pre-registration's whole point is that nothing about
the measurement changes after the night runs. If the parser is known-wrong at launch, then either we
fix it after the run — which is exactly the post-hoc edit the gate exists to forbid — or we carry a
diagnostic we already distrust. Fix it before the run or the run does not start."

🏗️ **Winston:** "I'd soften that: the RAW trace is archived with the verdict, so a post-run re-parse
with the corrected pattern is a pure re-read of frozen evidence, not a re-measurement — and the
diagnostic gates nothing anyway. But I agree there is no reason to argue about it at 3am when the fix
is one line today. Fix it now."

📐 **Dr Mira:** "One more thing nobody has said: **`RETAINED_STATE_FLAT_PCT_PER_HOUR = 0.5` is
uncalibrated.** No prior run collected `--trace-gc`, so there exists no real post-major-GC heap trace
to replay; the calibration's GC rows are synthetic — exactly-flat 40 MiB or exactly +0.5 MiB steps.
Real post-GC used heap varies, and a noisy 'rising' beside an RSS FAIL sends the hunt to heap
snapshots when it should go to native memory. The first 12-hour trace IS this diagnostic's first
calibration data. Its first classification must be labelled provisional — a reported observation with
an uncalibrated threshold, not a vetted instrument. The threshold is at least coherent: 0.5%/hr over
the four-hour window is 2% total, the band's own scale."

🎨 **Sally:** "On the coverage question as asked: yes, the requirement makes sense NOW — it was a bare
count of 4 when the brief was written, and `ca63859` upgraded it to 4 events AND span ≥ half the
window AND one load phase, which is what '4 collections in the same millisecond is not a trend' needed.
And INCONCLUSIVE-never-PASS is the only defensible missing-data outcome for an idle-ish Node server
that may simply never run 4 natural major GCs in four hours: the likeliest outcome of the night is
INCONCLUSIVE, the tree says that makes no claim and rescues nothing, and the repeated-INCONCLUSIVE
branch correctly points back at the DIAGNOSTIC's design, not the server. One nit for the record: the
`workloadComparable` check is vacuous at 12 hours — the window starts at hour 8, the ramp ends at
hour 4, so every in-window event is trivially past the ramp. Harmless, but it means that clause only
does work on compressed runs."

## Q3 — Is the decision tree complete?

📋 **John:** "I walked every branch: PASS+all-green closes the epic with the diagnostic reported
beside it and explicitly never converted into a leak-free claim; PASS+other-gate-FAIL holds on that
gate with no rescue; FAIL×{rising, flat, inconclusive} each name a different hunt; interruption is
recorded-incomplete-never-rescored like attempt 3; repeated INCONCLUSIVE is a finding about the
diagnostic, revisited once not twice. That is a tree that ends nights in decisions. I found one shape
it does not cover, and it is the one we have already been burned by."

🎨 **Sally:** "**Host contention inside the measured window.** Attempt 2's entire dispute was whether
the host confounded the measurement, and my bottom line last time was 'pre-register the whole tree so
the night ends in a decision, not a fourth review.' Attempt 4 ran an external telemetry sidecar and the
quiet-host premise was verified from it after the fact — max 1-minute load 1.04, min memAvailable
8.97 GiB. But the pre-registration fixes NO quiet-host criterion: no named telemetry source, no
thresholds, and no outcome shape for 'the sidecar shows a load spike at hour 10'. So picture the night:
RSS fails, telemetry shows a neighbour's build job inside the window — is that a FAIL, or incomplete-
confounded? Whatever is decided at 7am under that pressure will look fitted, BECAUSE IT WILL BE. One
paragraph fixes it: the source (the attempt-4 sidecar), the thresholds (the attempt-4 window's own
ceilings are a defensible start), and the shape — confounded → recorded under its own name as
incomplete, never scored, exactly the interruption branch."

📋 **John:** "Agreed, that is the missing branch and it blocks. Two smaller silences, for the record
rather than the gate: the tree never says what a `runtime-pinned-docs-drift` identity verdict does to
qualification — the harness proceeds on it, but every archived run (attempts 1–4) was
`candidate-exact`, so NO precedent exists for qualifying under docs-drift; the tree should say in one
line whether one may, rather than leave it to 7am; and the only thin-window floor is 'at least 3
samples' (`rel3-soak.mjs:1004`), where Mira's attempt-2 demand listed missing-sample handling — a
4-hour window that kept only a handful of samples through tracker stalls would still gate. Name a
minimum (240 expected; even 'at least 200, else incomplete' would do) or pre-accept the risk."

😤 **Grumbal:** "The 'zero loop errors' and 'artifact stability' gates the pre-registration lists ARE
wired into the verdict — I checked `rel3-soak.mjs:1683-1690` myself — so no doc/code mismatch there.
The tree's omissions are the three John and Sally named, and only the host contract is structural."

## Q4 — What would each voice refuse to start the run on?

📋 **John:** "Blockers: (1) the quiet-host contract, pre-registered — source, thresholds, confounded
shape; (2) the `Scavenge (reduce)` parser fix, because it is one line today and a governance argument
at 7am. Everything else — the decay row, the attempt-1-residuals noise model, the provisional label on
the flat threshold, the `fdBaselineAfterMs` cap (90 min vs 'after hour one' at 12 h: cap it at
3,600,000 ms like `reconnectEveryMs`, or pre-register the 90 minutes as the accepted reading), the
`runtime-pinned` line, the thin-window floor — is a pin or a one-liner that should ride along but
would not make me hold the night."

📐 **Dr Mira:** "I co-sign both blockers and insist the two calibration rows (decaying growth as a
pinned limitation; the phase rows replayed on attempt 1's residuals) land before the run too — they are
test-file additions, cheap, and they close the two ways the calibration could still flatter the rule.
If the owner declines the residuals row, write down WHY, pre-registered, so it is a decision and not an
omission."

🏗️ **Winston:** "Blocker: the parser line — though I hold that the archived raw trace makes it
recoverable either way, so unlike Grumbal I'd call it a must-fix rather than a gate-stopper; since the
fix costs a minute, the distinction never matters. I refuse nothing else. The window relocation is
sound engineering: it measures the server where measurement means something."

😤 **Grumbal:** "Both of John's blockers, and for me the parser one is a GATE-STOPPER on principle, not
convenience: a pre-registered measurement with a known defect is not pre-registered, it is pre-excused.
Winston and I do not agree on that principle and do not need to — the fix moots it. And I keep my
standing objection on the record: the 12-hour design is outcome-selected; its legitimacy rests entirely
on the falsifiability Winston named, so if hours 8–12 fail, nobody gets to propose 16."

🎨 **Sally:** "The host contract is mine and it blocks. Add the operator's one-liner to the
pre-registration: the sidecar launch command and where its log lands, so at 7am the evidence is a file
and not a memory."

**Where the table does not agree:** Grumbal maintains the 12-hour run is outcome-selected and only
conditionally legitimate; Winston and Mira hold it is the discriminating experiment FR-13's text always
implied. Grumbal holds the parser defect blocks as a matter of pre-registration principle; Winston holds
the archived raw trace makes it recoverable and blocks it only because the fix is trivial. Neither
clash needs resolution: both resolve operationally (fix the line; run the night; let hours 8–12 speak).

## Answers in brief

- **Q1 (honest?):** Yes. The statistic is FR-13's pre-existing text, it fails attempt 4 twice over,
  and the calibration enforces that permanently. The honest caveat: the 12-hour window relocation is
  the element engineered around attempt 4's failure mode — legitimate because it discriminates
  (a real retainer still fails hours 8–12) and because it restores FR-13's literal four hours. Missing
  controls: a decaying-leak limitation row and a realistic-amplitude (attempt-1 residuals) phase row.
- **Q2 (diagnostic adequate?):** Yes as REPORTED-only, with the upgraded coverage (count + span +
  load-phase) and INCONCLUSIVE-never-PASS both right. One defect: `Scavenge (reduce)` must leave the
  major-GC parser before launch. One label: the 0.5%/hr flat threshold is uncalibrated until this
  first real trace exists — its first classification is provisional.
- **Q3 (tree complete?):** One structural gap: no pre-registered quiet-host criterion or confounded-run
  outcome shape — the exact shape attempt 2 produced. Two minor silences: the `runtime-pinned-docs-drift`
  identity verdict, and a thin-window sample floor above the evaluator's 3.
- **Q4 (refuse to start on?):** (1) the quiet-host contract, (2) the parser fix. Ride-alongs that
  should land with them: the two calibration rows, the provisional label, the `fdBaselineAfterMs` cap
  or its pre-registered acceptance, one line each for `runtime-pinned` and the sample floor.

## What could not be verified

1. The brief's named verdict paths `docs/implementation/reviews/epic-6-soak-rss-final{,-claude}.md` do
   not exist; the prior verdicts were read from `.mailbox-out/epic-6-soak-rss-final{,-claude}` (the
   fact-check and bottom-line sections of each, not both files end-to-end).
2. The brief says the calibration is "seven rows / 7 pass"; the suite on disk is 10 tests, all passing
   (re-run here). The three extra KNOWN LIMITATION rows post-date the brief (`ca63859`).
3. Whether `Scavenge (reduce)` lines actually occur in this server's 12-hour trace is unknown (no real
   `--trace-gc` trace exists yet) — the parser finding is source-level: the pattern ACCEPTS them, and
   the claim "confirmed natural major collections" is false if one ever matches.
4. The equilibration-vs-slow-leak question itself remains empirically open until hours 8–12 exist; no
   statistic reviewed here can settle it in advance, and none claims to.
5. No soak, code edit, or release action ran in this review; the only executions were the calibration
   suite (10/10) and read-only greps/reads over the repository at `ca63859`.

TEAM_DONE epic-6-amendment-gate-claude2
