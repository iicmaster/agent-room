# Round-Table, round 4: the one question answered (`epic-6-quiet-host-round4-claude`)

**Verdict in one line:** YES WITH THREE PRECONDITIONS, and none of them is a review round — the
round-3 blockers are genuinely closed and were re-verified here empirically, but the chain that
closed them is an UNCOMMITTED working tree (11 modified files, a 435-line scorer diff), the
adjudication helper it ships has never once been executed (its last line dereferences a variable
that does not exist, under `set -u`), and the scorer that will judge the night has still never
produced an archived on-host adjudication. Commit, fix one word, rehearse once — then launch.

Task: epic-6-quiet-host-round4-claude. Advisory only, read-only: no repository file was edited,
no command that writes repository or evidence state was run, no agent was started. The sole
authored file is this outbox. Two read-only scorer invocations were run against the archived
rehearsal telemetry (output to stdout only).

---

## What this round verified before the voices speak

Every file the brief names was read in full, both round-3 verdicts were re-read (codex's R1–R5.5
closures were cross-checked against the code, not taken from the brief), and the closure table was
tested empirically where a read-only test existed:

1. **C1/R2 (the tail/boundary geometry) — CONFIRMED CLOSED, on the rehearsal's own telemetry.**
   The round-3 demonstration was repeated with the committed-to-be scorer: run-end
   `2026-10-22T08:15:50Z` (21 s off the observer's grid, the exact input that produced
   `window-ends-early` in round 3) now yields `tailSeconds: 0` and NO tail finding — the interval
   that spans the window's end covers it (`rel3-soak-eligibility.mjs:1019-1035`). The verdict was
   still INCOMPLETE, for exactly the right reasons: the rehearsal is five minutes long
   (`run-span-too-short`, a 13,718 s head gap) — fail-closed, honestly named.
2. **R1 (the missing prefix) — CONFIRMED CLOSED.** The head and tail checks are unconditional
   (`:1081-1093`, outside the cadence-registered block), judged by the intervals' RAW bounds
   (`:1030-1035`), and the fixture at `tests/soak/rel3-soak-eligibility.test.mjs:814` deletes the
   window's first 48 minutes and asserts `incomplete`.
3. **R3/C2 (digest enforcement) — CONFIRMED CLOSED, half empirically.** A scoring invocation
   without `--expect-thresholds-digest` exits 2 and scores nothing (run here; exit 2 observed).
   `rel3-soak-adjudicate.sh:88-101` refuses a scorer or extra-baseline whose bytes differ from the
   launch record, and `:106-110` refuses to overwrite an attempt's first verdict. The launcher
   records observer, self-check, scorer, launcher and extra-baseline digests (`rel3-soak-launch.sh:96-105`).
4. **F3 (the baseline double-count) — CONFIRMED CLOSED.** The same read-only scoring run shows
   `baselineMeasuredSamples: 25` (19 from the archived extra source + 6 pre-run), no
   `baseline-after-run-start` spam, no sample counted twice.
5. **R4/R5/R5.1–R5.5 — CONFIRMED CLOSED in the code.** Rows vs minutes split
   (`:1119-1125`; fixture asserts 39 rows / 48.75 minutes); raw accounting verified independently
   of the flags (`verifyAccounting` + `verifyRawAccounting`); the observer walks the cgroup TREE
   and publishes `ownPids=` (`rel1-soak-telemetry.sh:161-169,330`); the self-check reads CLK_TCK,
   asserts the PID SET pid-by-pid (5g), counts an ABSENT flag as failed and includes `runCgroupOk`
   (6d); the launcher's READY loop demands `interval=1` with sound signals and minute one enforces
   the whole partition. 40 `test(` fixtures counted.
6. **The archived burst trace** (`host-baseline-burst-window-2026-10-22.log`) was read: 41 rows,
   the first a synthetic zero, `foreignProcs` reaching 6–7 at 06:25–06:29Z. Two consequences below.

---

## The voices

**Mink** — instrument/metrology engineer. **Priya** — adversarial auditor. **Sarote** —
release/operations engineer. **Dara** — statistician. The same four who held the launch in round 3.

---

**Sarote:** My round-3 position was fix, commit, re-rehearse once, launch the same night — so the
question for me is whether that happened. Half of it did. The fixes are real; I watched Mink's
re-run of my own round-3 kill-shot come back with `tailSeconds: 0`. But look at `git status`:
eleven modified files, among them every script in the judging chain and the thresholds file, and a
scorer diff of 435 lines. The launch record's own sermon — "frozen means committed and pinned by
digest, a working tree one `git checkout` away from not existing is not a registration"
(`rel3-soak-launch.sh:15-17`) — currently describes this exact tree. And one of those uncommitted
files has a defect that proves nobody has run it: `rel3-soak-adjudicate.sh:154` interpolates
`$TELEMETRY_LOG`, a variable that exists only in the LAUNCHER; under the script's own `set -u`
that line kills the shell. Everything important has already happened by then — the scorer ran at
`:112`, the evidence was archived at `:123-128`, the adjudication record was written at `:149` —
so the verdict survives, but the helper then dies instead of reaching its `exit 0`, exits 1 on a
perfectly eligible night, and never prints the very command line it exists to disclose. Round 3's
complaint was that it exits 0 whatever the verdict; the fix made it exit 1 whatever the verdict.
One word (`TELEMETRY_LOG` → `TELEMETRY`) fixes it.

**Priya:** And that one word is the whole argument, Sarote, which is why I'm calmer than I was in
round 3. The pattern across four rounds is unbroken: every version of this chain has carried
exactly one defect its own proof could not see — and this round's instance is in the one script
that was edited but never executed. That is precisely why the third precondition is not optional:
one full launch→adjudicate rehearsal with the COMMITTED bytes, archived under its own attempt
name. The rehearsal evidence on file (`rehearsal-3929cc7-*`) was adjudicated by scorer
`5edb89f7…`, which no longer exists; the brief says "the archived record says so", and I checked —
it does NOT. The adjudication record carries no scorer digest at all (the helper records the
thresholds digest twice, `:144-145`, and verifies the scorer's digest without writing down what it
verified); the disclosure is only reconstructable from the launch record's pin plus the fact that
the current file differs. A re-rehearsal makes that whole argument moot by replacement, and it
would also have caught line 154. On my round-3 asks: the scorer and extra-baseline digests are now
ENFORCED at scoring — genuinely closed, and the committed-scorer re-check is the strongest link in
the chain now. Three residues, stated so the record has them, none blocking: `observer_digest` is
still write-only (defensible — the observer that wrote the night's log already ran; a later edit
cannot rewrite the log, so enforcement there protects little); the digest refusals at
`adjudicate.sh:90,95` are skipped when the record LACKS the line (`[ -n ... ]`) — fail-open on a
hand-made or truncated record, one `else exit` closes it; and `repo_changed_paths` is recorded and
still refuses nothing (`rel3-soak-launch.sh:94`) — the rehearsal launched with 6, tonight it would
say 14. Sarote will tell me precondition 1 makes it zero anyway.

**Sarote:** It does, and I'd still add the refusal line — it costs nothing and it is the only
thing that makes precondition 1 self-enforcing next time instead of a thing a review round has to
notice. But I won't hold the night for it.

**Mink:** The instrument I signed in round 3 and I sign again, now with the piece that was missing:
the boundary handling is proven on REAL telemetry, not only on fixtures whose geometry the
generator controls — the off-grid fixture (`test.mjs:847`) plus the rehearsal re-run close the
structural blindness I named. The raw-accounting verification is the right shape: monotonic
counters, interval/gap coherence, the census adding up, `foreignUs` against `foreignCores` within
0.002 — and the observer now logs the raw counters precisely so this recomputation never trusts
its arithmetic. Small things, honestly labelled: the scorer checks all of it TWICE
(`verifyAccounting` inside `parseSource`, then `verifyRawAccounting` on the same samples), so one
broken line yields two data problems under two different codes — noise, not error. The observer's
header still claims the per-minute sample is "fork-free" (`rel1-soak-telemetry.sh:39`) while
`cgroup_path_of` is a command substitution per foreign node process per sample, plus awk and date —
the cost sits inside the observer's own excluded cgroup, so the number is right and the sentence
is still false; third round I've said it, it's one line. And the helper still hands the scorer the
tracker-sample instant as `--run-end` (`adjudicate.sh:116`) when `--rss-window-end` exists for
exactly that meaning, so every archived verdict will say `runEndSource: "run-end"` about an
instant that is not the run's end. Cosmetic, disclosed in the window_note, but a chain this
pedantic about names should use the flag it built.

**Dara:** The gates I signed in round 3 and the arithmetic still holds. What did NOT happen is the
registered-text repair I conditioned Q2 on, and since the thresholds file is already modified and
will be re-digested at commit anyway, there is no excuse to freeze it with its round-3 errors plus
two new ones. In `rel3-quiet-host-thresholds.json`: (1) the magnitude sentence is still absent —
`knownLimits` states the duration boundary and stays silent that a neighbour at or below the
allowance passes BOTH gates at ANY duration; Priya and I did not converge on whether that is a
disclosed blind spot or a door, and we still do not, but we converged that the sentence must
exist, and it does not. (2) "the nearest-rank median over 240 samples selects rank 120" — the
four-hour window holds 241 samples at both-ends-inclusive 60 s cadence, and `nearestRank` over the
window's SAMPLES picks rank 121; the interval phrasing fixed the mean's units and left the
median's count wrong. (3) `calibration.hostBaselineWindows[0]` says `07:12:40Z/07:21:40Z` — nine
minutes — while the same entry claims 19 samples and the `baselineExpectation` note says the span
ends 07:30:42Z; one of those is wrong inside one frozen file. (4) New, found by reading the
archived burst trace the brief itself supplied: the registered burst statistics (41 samples, mean
0.954) INCLUDE the synthetic first sample — the measured rows are 40 with mean 0.978
(0.978 × 40⁄41 = 0.954), so the registration computes its own calibration in violation of its own
stated convention ("the observer's FIRST sample … is EXCLUDED from every statistic"). Calibration
is reported-only, nothing gates on it — but a contract whose sales pitch is "we measured this
host" should not carry a number its own rule forbids. The scorer's comment at `:1199` still says
bursts reach ~4 cores against the thresholds' ~2; the archived burst max is 1.966, so fix the
comment.

**Priya:** And the burst trace answers Sarote's round-3 open question while raising the honest
risk: `foreignProcs=7` at 06:29:42Z with no run present — the host ITSELF visits seven foreign
node processes during its own bursts. The registered limit is 7. Zero headroom: one extra foreign
process during a burst minute and the night is CONFOUNDED. The brief says that count is inflated
by the newline defect the review found — plausible, but unverifiable from the old-format log, so
it stays a risk, not an error. And it is a risk in the SAFE direction: a clean night voided and
recorded honestly, never a dirty night admitted. The owner should know the odds they are buying,
not be protected from them.

**Dara:** Agreed, and that is the correct framing for the whole remaining list: everything still open
fails toward INCOMPLETE or CONFOUNDED. Nothing we found in this round can make a bad window read
ELIGIBLE. That is the difference between round 3 and round 4, and it is why my answer changes.

**Mink:** Then the question, plainly. **Do we let the twelve-hour run start? Yes — after three
mechanical preconditions, none of which is another review.** (1) COMMIT the judging chain — the
scorer, observer, self-check, launcher, adjudicator, thresholds, and the refreshed self-check
evidence — so the launch record pins a commit that contains what it digests and
`repo_changed_paths` reads 0; fold Dara's four registered-text corrections and my two label fixes
into that same commit, since the thresholds digest changes anyway. (2) Fix
`adjudicate.sh:154` — one word — so the helper can reach its own exit. (3) Run ONE
launch→adjudicate rehearsal with the committed bytes (the five-minute `BASELINE_MINUTES` override
exists for exactly this) and archive it under its own attempt name; that replaces the only on-host
evidence still owed to a scorer that no longer exists, and it is the only step that executes
adjudicate.sh before the night depends on it.

**Sarote:** Yes with those three, and I ship the same night they are done — an hour of work, most
of it the rehearsal's wall-clock. I withdraw my round-3 resistance to Priya's "both lanes see the
diff": the diff IS this brief, both lanes have now seen it, and the obligation is discharged.

**Priya:** Yes with those three, and what I am accepting I will say in my own terms so the record
can quote it: I accept that the thresholds, the scorer and the extra baseline are now bound and
ENFORCED by digest at the only moment that matters — scoring — and that an attempt's first verdict
cannot be silently replaced. I accept operator-supplied run bounds as the procedural residue I
named in round 3, with trailing samples still unreported (the round-3 ask stands, non-blocking). I
accept `observer_digest` unenforced because the log already exists when anyone could tamper with
the file. I do NOT accept a launch from a dirty tree — that is not a new demand, it is the launch
record's own first sentence.

**Dara:** Yes with the same three, conditioned on the text corrections riding the commit. The
magnitude question — whether a sub-allowance permanent neighbour is a disclosed blind spot or a
structural door — remains UNRESOLVED between Priya and me, fourth round running; we agree only
that the registered file must state the fact and the owner must own the choice. The memory gate
remains the backstop that makes the choice survivable.

---

## The preconditions, ranked (the answer is NO until all three, YES the hour they are done)

| # | Precondition | Cost | Where |
|---|---|---|---|
| P1 | **Commit the judging chain.** 11 files are modified and uncommitted, the scorer by 435 lines; the launch record would read `repo_changed_paths 14`. "Frozen means committed" is the chain's own registered sentence. Fold in the registered-text fixes (magnitude sentence; 241/121; calibration window[0] span; burst stats recomputed over the 40 measured samples, mean 0.978; scorer comment ~4→~2 cores; observer "fork-free" line) — the thresholds re-digest happens at this commit anyway. Add the `repo_changed_paths==0` refusal to the launcher if cheap. | minutes | `git status`; `rel3-quiet-host-thresholds.json:26-29,48,56-64`; `rel1-soak-telemetry.sh:39`; `rel3-soak-eligibility.mjs:1199` |
| P2 | **Fix `TELEMETRY_LOG` → `TELEMETRY`.** Under `set -u` the helper's last line kills the shell: verdict archived, then exit 1 on every outcome, and the disclosed adjudication command never prints. Proof the file has never been executed since its edit. Also: record the VERIFIED scorer digest in the adjudication record beside the thresholds digests, and make a missing `scorer_digest`/`extra_baseline_digest` line in the launch record a refusal rather than a skip. | one word (+ ~4 lines) | `scripts/rel3-soak-adjudicate.sh:88-101,144-145,154` |
| P3 | **One launch→adjudicate rehearsal with the committed bytes, archived under its own name.** The only archived on-host adjudication was produced by scorer `5edb89f7…`, which exists in no file and whose removal the adjudication record does not itself disclose. The current scorer's on-host record is two read-only invocations made during THIS review. The rehearsal executes adjudicate.sh end-to-end — the one component nothing has ever run. | ~20 min wall-clock | `rehearsal-3929cc7-launch-record.txt:16`; `BASELINE_MINUTES` override in `rel3-soak-launch.sh:52` |

Non-blocking, on the record: trailing samples after the claimed run-end still unreported by the
scorer (round-3 F5 ask); `--rss-window-end` unused by the helper so `runEndSource` mislabels the
tracker instant; duplicate accounting findings (two codes per defect); the `run_end` sed at
`adjudicate.sh:65` left blank in the rehearsal record and nothing guarantees it matches tonight's
soak.log format; `foreignProcs` limit 7 equals the host's own observed burst maximum — zero
headroom, CONFOUNDED-direction risk only.

## Bottom lines

- **Mink (instrument):** YES after P1–P3. The instrument, the self-check and the boundary
  handling are signed — this time on real telemetry, not fixture geometry. The chain's four-round
  pattern (one unexecuted defect per version) is why P3 is a rehearsal and not a reading.
- **Priya (adversarial):** YES after P1–P3, nothing further. The digests are enforced where
  enforcement matters; the dirty tree is the last contradiction of the chain's own registered
  words, and P1 removes it. Trailing samples stay on the wishlist; the night's bounds stay
  operator-supplied and archived.
- **Sarote (operations):** YES after P1–P3, launch the same night. P2 is one word; the hour of
  work is mostly P3's wall-clock. No further review round — both lanes have now seen the diff.
- **Dara (statistics):** YES after P1–P3 with the registered text corrected in the same commit. A
  frozen file that miscounts its own samples, contradicts its own span, and computes its
  calibration against its own convention is not yet a registration — and every correction is
  prose, not a number that gates.

**Not resolved by the panel (fourth round):** whether a neighbour at or below the 0.5-core
allowance, sustained for the whole window, is a disclosed blind spot (Dara) or a structural door
(Priya). The registered magnitude sentence makes the owner choose; the memory gate is the backstop
either way.

## What could not be verified

- The full repository test suite with the 40 fixtures was not re-run (it writes temporary files;
  this task is read-only). The fixtures were read; the two headline behaviours (off-grid end,
  required digest) were verified by direct read-only scorer invocation instead.
- The brief's claim that the rehearsal adjudication's provenance is disclosed in the archive: the
  adjudication record carries NO scorer digest; the provenance is reconstructable only from the
  launch record's pin. P3 replaces the evidence and moots the point.
- Whether the burst log's `foreignProcs=7` is inflated by the pre-fix newline defect, as the brief
  states — the old-format log cannot distinguish it. Risk framed accordingly (confound-direction).
- The `run_end` sed against tonight's soak.log format — no current soak.log exists to test.
- The host's state tonight: the census is point-in-time; the four pinned foreign services may not
  be the night's four.

TEAM_DONE epic-6-quiet-host-round4-claude
