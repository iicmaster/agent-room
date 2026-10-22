# Round-Table: Attempt 4's final-window RSS FAIL on the final candidate (`epic-6-soak-rss-final-claude`)

**Verdict in one line:** the FAIL stands on the record — attempt 4 is NOT a GC-phase coin flip (every
phase-robust statistic over the same window also exceeds 2%), but the rule as placed IS measuring the
server's equilibration to its heaviest-ever load, not retention; the honest path is a pre-registered,
owner-ratified rule amendment (harness-only — it does not void candidate `3929cc7`) plus one longer run,
and no door ships v0.2.0 today.

Task: epic-6-soak-rss-final-claude. Advisory only; no soak, gate change, candidate change, or release
action was performed. The sole authored file is this outbox.

## Pre-table fact check (recomputed from the stored evidence, not taken from the brief)

Hour bins below are tracked-sample index bins (samples 1–60, 61–120, …), not the brief's clock-hour
bins — the numbers therefore differ slightly from the brief's table, and these bins align exactly with
the evaluator's window (window = samples 241–480 = bins 5–8).

1. **The evaluator replays exactly.** From `attempt4-3929cc7.json`'s 481 samples, the shipped formula
   (`tests/soak/rel3-soak.mjs:974-1006`) reproduces `growthRatio` 0.02239 and `impliedGrowthRatio`
   0.03988 — identical to the archived verdict. Window: 240 samples, 113.95 → 116.50 MiB.
2. **The quiet-host premise holds.** The external sidecar (`attempt4-3929cc7-telemetry.log`), parsed
   over the final window (17:16–21:17Z, 241 lines): max 1-minute load **1.04** on a 4-CPU host, min
   memAvailable **8.97 GiB**, max node process count **6**, max `pgmajfault` delta **254/min**. The
   only load spike (1.69) is at 21:18Z, during the drain, after the window closed. Attempt 4 is not
   attempt 2; contention is excluded this time.
3. **The brief's "flat post-GC floor" claim is wrong — the second time in a row a brief's own
   explanation is refuted by its own samples.** Window hourly minima: **108.5 → 110.7 → 111.8 →
   111.8 MiB (+3.1%)**. Window hourly means: **111.7 → 114.7 → 114.7 → 115.4 (+3.2%)**. Matched-phase
   (last 60 samples minus first 60, same sawtooth phase): mean **+3.62 MiB**, 54/60 positive. The two
   troughs the brief quotes (106.9 → 111.0) are themselves +4 MiB apart in 25 minutes. Every
   phase-robust statistic over THIS window exceeds the 2% bound.
4. **The endpoint phase actually leaned toward PASS.** The window opened at 113.95 MiB — above that
   hour's 0-actor idle sample (110.3 MiB). A high start biases `growthRatio` down, and the run still
   failed. The "coin flip on where the GC cycle sits" framing is not what happened.
5. **But the growth is decelerating to flat.** Hour-over-hour floor (minima) deltas across the whole
   tracked run: **12.2, 2.4, 1.3, 4.3, 2.2, 1.1, 0.0 MiB** — the final two hours' floor delta is zero.
   A per-message retainer at the run's steady message rate would hold roughly constant deltas; these
   decay. Consistent with asymptotic equilibration — and also consistent with a slowing leak or 8 hours
   of OS-RSS noise. Three to four points cannot discriminate; only hours 9–12 of a longer run (or heap
   telemetry) can.
6. **The structural finding: the final window coincides exactly with the first four hours of
   full-cap load.** The profile ramps payloads linearly to the 32 KiB cap across the FIRST half and
   holds at the cap for the second (`rel3-soak.mjs:302-305`, header lines 79-83); the final window is
   the second half. So the rule demands the process sit within 2% of its asymptote during the very
   hours it first equilibrates to the heaviest sustained load it has ever carried. Warmup does run at
   the cap, but as short unpaced rounds against an empty store — not four hours of sustained cap
   traffic over a DB grown toward a gigabyte.
7. **Calibration across quiet hosts:** the same rule on quiet hosts has now output **−29.5% / −12.6%**
   (attempt 1, macOS — different RSS semantics, so a caveated comparison) and **+2.24% / +3.99%**
   (attempt 4, Linux) against a **2%** bound. The measurement's own run-to-run spread is an order of
   magnitude wider than the bound it gates.
8. **Retention scan of the shipped server (not a full audit):** every in-memory collection inspected is
   bounded or request-scoped — `sessions` capped at 1,000 with lazy sweep + eviction
   (`server/api/session.mjs:59-95`), `superseded` bounded like the session map (`session.mjs:68`),
   challenge `pending` capped (`challenge.mjs:44-70`), rate-gate buckets lazily swept past the refill
   horizon (`rate-gates.mjs:68-80`), `mostRecentPerActor` request-scoped (`server.mjs:746`). Messages
   live in SQLite, not the heap. If the floor rise were retention, it would be ~3.3 MiB ÷ ~11,540
   window messages ≈ **300 bytes/message** — findable only with heap telemetry, not OS RSS.

At the table (continuity with the archived attempt-2 reviews): **John** (PM), **Dr Mira**
(measurement/statistics), **Winston** (runtime architecture), **Grumbal** (qualification assurance),
**Sally** (operator experience).

---

📐 **Dr Mira:** "Let me say the uncomfortable part first, because it happened twice. Attempt 2's brief
said 'unlucky phase' and the samples refuted it. This brief says 'the post-GC floor is roughly flat and
the peak climbs with V8's feedback' — and the samples refute that too: the floor climbs 3.1% inside the
window, the means climb 3.2%, and 54 of 60 matched-phase differences are positive. **Question 1's
premise is false as stated: this is not the GC's phase.** If you re-point the rule at any honest
phase-robust statistic over the same window — hourly medians, hourly minima, matched-phase deltas, OLS
over integer cycles — attempt 4 still fails. Including the correction the attempt-2 review already put on the
table: drop the endpoint `growthRatio` term as an unratified addition and gate only on what the PRD
itself ratified (`prd.md:239`, the least-squares slope) — attempt 4's `impliedGrowthRatio` is
**0.0399 against 0.02**, so the PRD's own term fails it twice over. There is no 'smallest honest
correction' that turns this particular run green, and anyone proposing one should be made to say that
sentence out loud."

🏗️ **Winston:** "Agreed on the arithmetic, Mira, and now the physics. The floor deltas decay 2.2 →
1.1 → 0.0 across the window's hours. That is not what a per-message retainer does at constant message
rate; it is what a process does approaching an asymptote. And the asymptote moved mid-run **by
design**: the profile holds payloads at the 32 KiB cap only in the second half, which is exactly the
final window. We built a rule that asks 'has memory stopped growing?' and pointed it at the first four
hours in which the process has ever carried its maximum sustained load. Attempt 1 'passed' the same
geometry at **−29%** — a descent as far below the bound as this miss is above it. Mira's point 7 is the
real indictment: a gate whose output on two clean runs spans [−29%, +4%] against a ±2% bound is not
measuring the server; it is measuring where in the equilibration curve the window landed. I also went
looking for the retainer the brief asks about: every map in the session, challenge, and rate-gate paths
is bounded; messages land in SQLite. The honest residual suspects for a rising floor are V8's
heap-limit feedback, SQLite page-cache/mmap growth as the DB passes a gigabyte, and allocator
fragmentation — all of which plateau, and none of which OS RSS can tell apart from a 300-byte-a-message
leak."

😤 **Grumbal:** "I want the room to hear what attempt 4 IS before anyone touches a file. In the
attempt-2 review I demanded one thing: a pre-declared quiet-host run, unchanged candidate, unchanged
rule, with synchronized host observations. **I got exactly that run. It failed.** This is not attempt
2; there is no contention to blame — I checked the sidecar myself and the window is clean. So the
record reads: the ratified gate, applied correctly to a candidate-exact artifact on a quiet host,
says FAIL, and the epic's own law says a FAIL holds the release. Winston, your equilibration story is
plausible — and it is a **story**, resting on three decaying deltas from single-sample minima. The
previous two briefs also had plausible stories. If you rewrite the rule now, after the third
consecutive FAIL, every future auditor reads it as: 'they adjusted the gauge until the candidate fit.'
The only amendment I will sign is one written **blind**: pre-registered statistic, pre-registered
bound, calibrated on traces that are not this run, ratified by the owner, and then an 8-plus-hour run
that nobody gets to re-score. And (c) — rerun as-is and hope — is worse than either honest option: with
a measured 4% OLS, a repeat most likely fails again, and a lucky pass would qualify nothing but our
luck."

📐 **Dr Mira:** "Grumbal and I agree more than he thinks. My calibration demands from the attempt-2
review stand word for word: a preregistered full-cycle statistic, explicit window anchoring, explicit
denominator, replayed against attempt 1, attempt 2, attempt 4, AND synthetic traces with known injected
growth around the bound — chosen because it detects real growth, never because it clears attempt 4.
Where I part from him: the rule's defect does not need attempt 4 to prove it. Point 6 is structural and
was visible the day the ramp and the window were both ratified — the window measures equilibration **by
construction**. And one more trap to name now, because someone will propose it: 'gate the final two
hours' floor, which is 0.0'. Choosing that window BECAUSE it is the one that passes is the exact
goalpost-moving Grumbal fears. The defensible amendment anchors the window at **measured
stabilization** — the same trailing-slope discipline the harness already applies to its own warmup
(`rel3-soak.mjs:1779-1786`) — or extends the run so the cap-load hold is long enough that the final
four hours sit demonstrably past the knee. Both must be chosen and bounded before the next launch."

🏗️ **Winston:** "And the discriminating experiment is cheap to specify: one **12-hour diagnostic**
run — ramp four hours, hold at cap eight — explicitly labelled diagnostic, not qualifying. If hours
9–12's floor is flat, the equilibration story is confirmed and the amended rule qualifies on the
NEXT run; if the floor is still climbing ~1 MiB/hour at hour 12, we have a real retainer, the brief's
Question 2 answer becomes 'yes, the server retains something', and we go hunting with heap snapshots —
`--heapsnapshot-signal` is a Node flag on the harness's spawn, not a candidate byte. Either way the
record gains a fact instead of a hope."

📋 **John:** "Governance, and the brief's Question 3, which splits into two answers people keep
conflating. **First: no, a rule change does not void the candidate.** The packager's inputs are
`plugin.json`, `mcp.json`, `server/`, `web/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`
(`scripts/package-release.mjs:45-46`). `tests/soak/rel3-soak.mjs` is not among them; editing it changes
neither tree digest, and the REL-1 evidence and the soak's candidate-exact identity are untouched.
**Second: that does not make it free.** The rule's text is ratified three times over — the Story 6.2
acceptance in `docs/epics.md`, the PRD's single-pass-rule clause (`prd.md:239`, verified firsthand: 'this
band is the single pass rule; no story may impose a stricter or looser memory criterion'), and the
Epic 6 advisor review that fixed the total-growth reading. Amending it is a spec amendment: owner decision, fresh advisor review,
pre-registration before any qualifying run — and attempt 4 is never retroactively re-scored as a pass;
any replay under a proposed metric is labelled diagnostic, exactly as we held for attempt 2. On the
release: **door (a) is where we stand tonight** — v0.2.0 is held, the FAIL is recorded under its own
name. Door (c) is rejected: we do not spend eight machine-hours purchasing a coin toss we already
measured to be weighted against us. Door (b) is the path out, but only through the gate Mira and
Grumbal just built around it, and I will add the schedule truth: ratification plus a 12-hour run means
v0.2.0 ships no earlier than two days from the owner's decision."

🎨 **Sally:** "Operator reality: this was the third all-night soak, run correctly — quiet host held for
eight hours, sidecar kept, evidence filed. The process asked the operator for discipline and the
operator delivered; the rule then failed the run by 0.24 points on a statistic whose run-to-run spread
is ten times its bound. If the next run's verdict can again depend on where an equilibration knee
lands, we will burn a fourth night and be back at this table. So whichever branch is chosen,
**pre-register the entire decision tree before launch** — pass means ship, this-shape-of-fail means X,
that-shape means Y — so the night produces a decision, not another review. One tangent, said once: the
REL-4 record's last sample (201.2 MiB 'post-drain') is taken the instant the clients close, pre-GC,
and is worthless as a settled footprint; a 60-second settle before that sample is a two-line harness
edit that would make the counter-metric mean something next time. It gates nothing, so it changes
nothing tonight."

---

## Where the voices cannot agree (preserved, not resolved)

1. **Amend-then-run vs diagnostic-then-decide.** Mira and Winston hold the rule defect is structural
   (window ≡ first hours at cap; bound below the measurement's own spread) and provable without
   attempt 4, so the amendment can be ratified now and the next run can qualify under it. Grumbal holds
   that after three FAILs, any amendment authored now is tainted regardless of its merits, and only the
   12-hour **diagnostic** (old rule intact, result binding neither way) can precede ratification.
   John declines to break the tie — it is the owner's call, and the two paths differ by about a day.
   The tradeoff is audit optics versus calendar, and the record cannot settle it.
2. **What the decelerating floor means.** Winston reads 2.2 → 1.1 → 0.0 as equilibration completing
   inside the window. Mira and Grumbal refuse the inference from three single-sample minima: the same
   data fits a slowing leak or plain OS-RSS noise. All agree only hours 9–12 (or heap telemetry)
   discriminate — which is why neither (a)-forever nor (b)-immediately closes the question.

## Answers on the record

- **Q1:** The rule is not measuring a leak, and it is not measuring GC phase either — the brief's
  coin-flip framing is refuted by this run's own samples (floor +3.1%, means +3.2%, 54/60 matched-phase
  positive inside the window; the endpoint phase actually favored passing). What it measures, as
  placed, is **where the window sits on the equilibration curve of a process whose load profile moves
  the asymptote mid-run** — with a 2% bound sitting far inside the statistic's demonstrated [−29%, +4%]
  quiet-host spread. The growth inside this window is real; whether it is benign equilibration or
  ~300 B/message of retention is **not decidable from OS RSS**, and no scanned in-memory structure
  retains per-message state (bounded maps throughout; messages in SQLite).
- **Q2:** (a) stands tonight — the record keeps the FAIL under the ratified rule. (c) is rejected by
  every voice. (b) is the path out, with the smallest HONEST correction being: gate a settled
  statistic (post-GC floor / full-cycle regression) over a window anchored at **measured
  stabilization under cap load** (or a run extended so the cap-hold outlasts the knee), pre-registered
  and calibrated per the attempt-2 review's demands, owner-ratified, then one fresh qualifying run.
  No honest statistic over attempt 4's existing window rescues attempt 4 — that sentence belongs on
  the record. If the 12-hour diagnostic shows the floor still climbing past hour 9, the answer flips:
  the server IS retaining something small, and the hunt moves to heap snapshots before any release.
- **Q3:** Confirmed, with a split: `tests/soak/rel3-soak.mjs` is not a packaging input
  (`scripts/package-release.mjs:45-46`), so a rule change neither changes the candidate's bytes nor
  voids the soak's candidate-exact identity or the REL-1 evidence. But the rule's TEXT is ratified
  spec (epics Story 6.2, the PRD's single-pass-rule clause), so the change requires owner ratification
  and pre-registration — bytes-safe is not governance-free.

## Each voice's bottom line

- 📋 **John:** "Hold v0.2.0 on attempt 4's recorded FAIL. A harness rule change does not void
  `3929cc7` — and still needs the owner's ratification before any run under it can qualify. Reject
  (c) outright."
- 📐 **Dr Mira:** "The coin-flip diagnosis is refuted by the run's own floor trend — say so plainly.
  The rule is still miscalibrated: its quiet-host spread is 10× its bound and its window measures
  equilibration by construction. Amend it only through preregistration and calibration on traces that
  are not attempt 4, and never anchor the window on the sub-interval that happens to pass."
- 🏗️ **Winston:** "No retainer found in the shipped maps; the decaying floor deltas point at
  equilibration against a mid-run-moving asymptote — the window/ramp coincidence is a design flaw. Run
  the 12-hour diagnostic: flat hours 9–12 confirm it; a still-climbing floor means a real retainer and
  heap snapshots before anything ships."
- 😤 **Grumbal:** "The clean replication I demanded was run and it failed — this FAIL is unconfounded
  and it stands. No rule authored after three red runs touches qualification until the owner ratifies
  a blind, pre-registered amendment; until then the only run I accept is a diagnostic that binds no
  verdict."
- 🎨 **Sally:** "Pre-register the whole decision tree before the next 8-to-12-hour night so it ends in
  a decision, not a fourth review. And give REL-4's post-drain sample a settle delay so the one
  counter-metric we keep recording stops being meaningless."

## What could not be verified

1. **V8 internals:** no GC events, heap-space breakdown, or allocation telemetry exist for any
   attempt; the tracker records OS RSS and FD count only. The brief's live memory-map figures
   (anon/THP/shared-clean split, the 19:09–19:14Z `smaps` readings) are not in the archived evidence
   and were taken on faith as quoted.
2. **The retention question itself:** the scan of session/challenge/rate-gate/claims code found only
   bounded structures, but it was targeted, not a full-server audit; a ~300 B/message retainer
   (or SQLite page-cache/fragmentation growth) is neither proven nor excluded by OS RSS.
3. **Whether hours 9–12 would flatten:** no run longer than ~8 tracked hours exists; the
   equilibration-vs-slow-leak question is empirically open until one does.
4. **Raw ack journals and payload byte-exactness** were taken from the attempt-4 record as archived
   (23,080 == 23,080, 0 duplicates), not independently replayed here; likewise attempt 1's samples
   were compared via the archived reviews, with the macOS-vs-Linux RSS semantics caveat applied.
5. No soak, test suite, or release action ran during this review; the recomputations above were
   read-only scripts over the archived JSON and telemetry.

TEAM_DONE epic-6-soak-rss-final-claude