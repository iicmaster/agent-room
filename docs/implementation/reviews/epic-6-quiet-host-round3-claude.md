# Round-Table, round 3: the frozen rule re-read, the rehearsal re-run, and whether the night may start (`epic-6-quiet-host-round3-claude`)

**Verdict in one line:** the round-2 findings are genuinely closed as described — and the panel
still refuses to let the run start, on two things the brief does not know about: a tail-gap check
in the committed scorer that would void roughly three clean nights in four (demonstrated below,
read-only, against the rehearsal's own telemetry), and the fact that the scorer that will judge
the night is NOT the scorer that produced the rehearsal evidence — it was edited after the
rehearsal, the launch record's digest proves it, and nothing in the chain re-checks that digest
at scoring time.

Task: epic-6-quiet-host-round3-claude. Advisory only, read-only: no file was edited, no command
that writes was run, no agent was started. The sole authored file is this outbox.

---

## What this round verified before the voices speak

Every file the brief names was read in full: the observer, the self-check, the scorer, its 30
fixtures (counted: exactly 30 `test(` blocks), the thresholds file, the launcher, the adjudicate
script, the amendment, and the evidence under `docs/release-evidence/v0.2.0-quiet-host/`. Digests
were recomputed and two read-only scorer invocations were run against the archived rehearsal
telemetry. The concrete evidence:

1. **Digest comparison against the launch record.** Current repo files vs
   `rehearsal-3929cc7-launch-record.txt`: thresholds `ccb4bcae…` MATCHES; observer `919541ff…`
   MATCHES; launcher `0ec2dd9c…` MATCHES; **scorer does NOT** — the record pins
   `5edb89f7…`, the committed `scripts/rel3-soak-eligibility.mjs` is `0f54e8b0…`.
2. **Behaviour diff of the two scorers.** Re-running the committed scorer with the rehearsal's
   exact bounds, the same `--baseline-extra`, and the recorded thresholds digest reproduces the
   archived finding codes EXCEPT one: the archived adjudication carries
   `limits-disagree-with-baseline` as a DATA problem (→ INCOMPLETE); that code does not exist in
   the committed scorer — the same comparison now lives in `advertisedVsComputed` as a reported
   diagnostic that gates nothing. The judge was relaxed after its only on-host execution.
3. **The tail-gap demonstration.** `rel3-soak-eligibility.mjs:791-801` and `:828-830` compare the
   window's tail (`windowEnd − last in-window sample`) against `cadenceToleranceSeconds` (15 s),
   not against `cadenceSeconds + cadenceToleranceSeconds` (75 s). Run read-only against the
   rehearsal telemetry with `--run-end 2026-10-22T08:15:50Z` (21 s past the last in-window
   sample, i.e. still INSIDE one cadence): verdict carries `window-ends-early`, tailSeconds 21.
   With the archived `--run-end 2026-10-22T08:15:38.356Z` (tail 9 s): no such finding.
4. **Git archaeology.** `repo_commit 01504a3` is an ancestor of `main`;
   `git show 01504a3:scripts/rel3-soak-eligibility.mjs` fails — the scorer existed in NO commit
   at launch time, and `repo_changed_paths 6` says the rehearsal ran from a dirty tree.
5. **The round-2 closure table itself checks out.** The cgroup record is read newline-delimited
   and compared exactly with child-cgroup inclusion (`rel1-soak-telemetry.sh:147-156`, `:255-257`);
   the validity flags exist and the scorer requires all five; `--run-start`/`--run-end` are
   required and coverage is elapsed-time; the contract row gates median + elapsed-time mean; the
   absolute limits gate and a relative-only file is INCOMPLETE (fixture at test 23); the digest
   binding works both ways (fixture at test 24); the launcher verifies placement and enforces
   minute one; the synthetic first sample is excluded; the `grep -c` and CLK_TCK fixes are in.
   Nothing in the round-2 list was found reopened.

---

## The voices

**Mink** — instrument/metrology engineer. **Priya** — adversarial auditor, owns the question
"can the verdict still be decided after the night". **Sarote** — release/operations engineer,
owns the launch path and the runbook. **Dara** — statistician, owns the detection boundary.

---

**Sarote:** I'll start with the thing that kills the night even if everyone here is honest.
The scorer's tail check. The window's end is the harness's LAST TRACKER SAMPLE — that timestamp
lives on the harness's clock, not on the observer's 60-second grid. So on any real night,
`windowEnd − lastInWindowSample` is roughly uniform on [0, 60). The check at
`rel3-soak-eligibility.mjs:828` voids anything over 15 s. That's ~3 nights in 4 marked
INCOMPLETE on PERFECT telemetry. The rehearsal survived on luck — tail 9 s, observer at :28/:29
against a tracker at :38.356. I demonstrated the failure with the rehearsal's own log and a
run-end 21 s off-grid: `window-ends-early`, INCOMPLETE. The error message even says "more than
the registered 60s cadence allows" — the message is right and the code is wrong.

**Mink:** And the thirty fixtures can't see it, which is the part that should sting. `buildLog`
in the test file derives the sample grid FROM `runEnd` (`windowStartMs = runEnd − 4h`, samples
every 60 s from there), so the last sample always lands exactly on the window's end — tail 0 by
construction. The 48-minute-absent fixture tests a real hole, not a normal sub-cadence tail. The
head side was handled correctly — a head gap up to 59 s is recorded and tolerated — so somebody
THOUGHT about grid phase at one end of the window and not the other. The fix is one comparison
(`cadence + tolerance`, or: the first sample AFTER windowEnd must sit within one cadence of the
last one inside — the observer deliberately outlives the soak by 65 s precisely so that sample
exists) plus one fixture with an off-grid run-end. But it must happen before the night, and it
reopens the "the suite is green therefore the scorer is proven" claim: the suite is green over a
fixture generator that structurally cannot produce the most ordinary real-world geometry.

**Priya:** Which hands me Q1, because my answer is NO, and not on a technicality. The launch
record — the artifact this whole round-3 brief holds up as the proof that "frozen means
committed and digested" — pins scorer `5edb89f7…`. The committed scorer is `0f54e8b0…`. I
re-ran the committed scorer over the rehearsal's inputs: the archived adjudication has a finding
code, `limits-disagree-with-baseline`, that the committed scorer cannot emit. So the sequence
was: the rehearsal ran, the stricter scorer voided on a check, and the check was removed
afterwards. The brief's closure table does not disclose that edit. To be fair about the content:
the removal was probably CORRECT — that check compared the registered absolute limits against
baseline-plus-allowance recomputed from each night's 15-minute baseline, so ANY drift, including
drift inside the registered tolerance, would void every night; the baselineExpectation check is
the right instrument and it stayed. But "we edited the judge after its only on-host run, for
good reasons, and didn't mention it" is exactly the shape of thing this contract exists to make
impossible. And structurally nothing stops a repeat: `rel3-soak-adjudicate.sh` re-checks ONLY
the thresholds digest. `scorer_digest` and `observer_digest` are written at launch and never
read again. The launcher records `repo_changed_paths` and refuses on nothing — the rehearsal ran
with 6 changed paths, at a commit where the scorer existed in no commit at all.

**Sarote:** On the enforcement point I'm with you, and I'll add the finding that's mine: the two
pre-registered adjudication commands DISAGREE. The launch record's `adjudication_command`
(`rel3-soak-launch.sh:250`) passes the run's own telemetry log as `--baseline-extra`. Follow it
on a real night and every run-phase sample in the extra source trips `baseline-after-run-start`
— hundreds of data problems, guaranteed INCOMPLETE, perfect night or not. The rehearsal DID
follow it: six of those rejections sit in the archived JSON, and the seven pre-run samples were
counted TWICE (`baselineSamples: 14`, through `--telemetry` and `--baseline-extra` both), which
is the only reason `baselineMeasuredSamples: 12` cleared the registered minimum of 12 — the real
baseline was 6 measured samples. Meanwhile the committed `adjudicate.sh` does it right (the
archived host-baseline log as the extra source) — but adjudicate.sh is not digested in the
launch record, it passes WINDOW_END as `--run-end` so `runEndSource` says "run-end" about a
tracker-sample instant, its `run_end` line in the rehearsal record is blank (the soak.log `sed`
didn't match), and it exits 0 whatever the verdict. The frozen record names a command the scorer
rejects; the script that works is the one nothing pinned.

**Mink:** Priya, one more residue for your Q1 ledger, and then I want to defend the instrument.
The run's bounds are operator-supplied at adjudication. They COME from the run's own results
JSON — which cannot be pre-registered, it doesn't exist at launch — so the protection is
procedural: archived results, archived soak.log, auditable arithmetic. The scorer could narrow
that freedom cheaply: it silently ignores every sample AFTER the claimed run-end (the rehearsal
log has one, 08:16:29), so a run-end chosen to end the window on a quiet stretch leaves visible
trailing samples the verdict never mentions. Report them at minimum. That said: the instrument
itself I'm now prepared to sign. The cgroup record is parsed newline-delimited and compared
exactly, children included; the partition was proven per-PID against actual cgroup membership
(5f), the fixture's CONTRIBUTION is asserted (2), the worst single sample since the exit is
bounded (4b), and the rehearsal row `ownProcs=7 foreignProcs=4` is the row the round-2 version
could not produce. Two label corrections, not findings: the observer's header still says the
per-minute sample is "fork-free" — `cgroup_path_of` at `rel1-soak-telemetry.sh:249` is a command
substitution per node process per sample, plus an awk and a date; the cost is inside the
observer's own cgroup and excluded from the residual, so it's harmless, but the sentence is
false. And `minutesAboveOneCore` counts ROWS in a document where everything else is elapsed
time — reported-only, so cosmetic.

**Dara:** Q2, then. The duration arithmetic in `knownLimits` is now honest and I verified it:
180 core-minutes under the mean gate; the median moves only past half the window, so the joint
blind spot for a one-core neighbour is ~119 minutes, and the brief's "under about two hours" is
the right summary. Two corrections. Small one: the window holds 241 samples, not 240 (both
endpoints inclusive at 60 s cadence), so nearest-rank picks rank 121 — changes nothing, but a
registered convention should count its own samples correctly. Real one: the boundary is stated
only in DURATION, and it is silent about MAGNITUDE. A +0.5-core neighbour sustained across the
ENTIRE four hours: median 0.845 + 0.5 = 1.345, and the gate is `!(median <= 1.345)` — passes at
exact equality; mean 1.326 against 1.576 — passes with room. That is 120 core-minutes of
sustained interference, invisible to both gates, for all 240 minutes.

**Priya:** And that's not a corner case, Dara, that's the registered allowance functioning as a
permanent free rider. A neighbour that politely stays at half a core forever is EXACTLY a
neighbour, and the contract waves it through by construction.

**Dara:** By DISCLOSED construction — the allowance is 0.5 cores, registered, derived from a
host whose own PHP builds move busy time by more than that. Gate tighter and you void clean
nights on the host's own behaviour; that's F18 a third time. What the rule needs is not a
tighter number, it's one more sentence in `knownLimits`: "a neighbour at or below the allowance
is invisible at ANY duration." The memory gate is the backstop for whether that interference
mattered — the quiet-host gate was never a security boundary, it's a confound detector. Also,
while I'm at the file: the thresholds note says the host's bursts reach "~2 cores" and the
amendment says busy time moves "between roughly 0.2 and 4.0 cores" — one of those sentences is
wrong, and in a document whose whole argument is "we measured this host", the two should agree.

**Mink:** I won't resolve you two, and the outbox shouldn't. For my part: equality-pass at
exactly the limit is standard and fine; the missing magnitude sentence should be added; the
number itself I'd keep.

**Sarote:** Remaining small items so they're on the record. The launcher's READY loop accepts
the observer's FIRST sample — `interval=0`, whose delta arithmetic has never run; one more
sample costs 60 seconds and actually proves the thing the loop claims to prove. The launcher's
pre-run baseline check hardcodes a minimum of 6 measured samples against a registered minimum of
12 — fail-safe direction (the scorer still enforces 12... except the rehearsal just showed 12
can be met by double-counting, so fix F3 and this matters). And one thing I could not explain
from the archive: the self-check telemetry at 07:55 shows `foreignProcs=7` with the run absent,
while the census at 07:11 pinned 4 — if the host genuinely visits 7 foreign node processes on
its own, the registered limit of 7 has ZERO headroom in the host's worst observed state.
Possibly leftovers from rehearsals 1–3; nobody wrote down which. Worth one look before the
night, not a blocker.

**Priya:** Then the answers, plainly. **Q1 — is the rule frozen in the sense we meant? No.**
The thresholds are: committed, digested, bound at scoring, proven by fixture 24. The JUDGE is
not: its digest is recorded and never enforced, it demonstrably changed after the rehearsal, and
the frozen launch record pre-registers an adjudication command that the committed adjudicate
script correctly refuses to follow. Three sentences of shell close it: adjudicate.sh compares
scorer and observer digests against the launch record; the launcher refuses `repo_changed_paths
> 0`; the launch record's command is generated from adjudicate.sh instead of hand-written.

**Dara:** **Q2 — is the boundary stated honestly? On duration, yes — and it is acceptable to
ship,** because the alternative (gating tails) demonstrably voids clean nights on this host's
own bursts, and everything ungated is still reported and archived. On magnitude, not yet: add
the sub-allowance-forever sentence, fix 240→241, reconcile ~2 vs ~4 cores. Priya holds that a
blind spot you can park in forever is not a boundary but a door; we did not converge, and the
owner should read both sentences and pick.

**Mink:** **Q3 — what did we miss, and may the run start? It may not start yet**, and this
time the defect is in the SCORER, which both lanes spent round 2 strengthening: the tail check
(F1) voids ~75% of clean nights, its fixtures are structurally blind to it, and it was found by
geometry (where does the tracker's clock land on the observer's grid), not by reading harder.
The pattern across three rounds is consistent: every instrument version so far has carried one
defect its own proof could not see. Which is the strongest argument that after F1–F3 are fixed,
the chain needs ONE more cheap pass — not a round 4 of prose, a re-run: the rehearsal executed
again on the host with the COMMITTED scorer, and its adjudication archived to replace evidence
that an edited-away judge produced.

**Sarote:** Agreed on the re-run, against on another review round. F1 is one comparison and one
fixture; F3 is one line in the launcher; the digest enforcement is three lines in adjudicate.sh.
Fix, commit, re-rehearse, launch the same night. The chain's honesty is the best thing about it
— every one of these defects was found IN the artifacts the chain itself archived.

**Priya:** And I want the round 4 — not of the code, of the DIFF. Whoever fixes F1–F3 sends the
diff and the re-rehearsal record to both lanes before the night; thirty minutes, not a cycle.
The last two "one-line fixes" in this epic each contained the next finding. We did not converge
on this either: Sarote ships after the re-rehearsal, I ship after both lanes have seen it.

---

## The findings, ranked

| # | Severity | Finding | Where |
|---|---|---|---|
| F1 | **BLOCKER** | The window-tail check compares the tail against the 15 s tolerance instead of cadence+tolerance (75 s); a real night's run-end is off the observer's 60 s grid, so ~3 clean nights in 4 come back INCOMPLETE. Demonstrated read-only against the rehearsal telemetry (tail 21 s → `window-ends-early`). The fixtures cannot see it: `buildLog` aligns the sample grid to `runEnd`, so the fixture tail is always 0. | `scripts/rel3-soak-eligibility.mjs:791-801,828-830`; `tests/soak/rel3-soak-eligibility.test.mjs:124-137` |
| F2 | **BLOCKER (Q1=no)** | The committed scorer (`0f54e8b0…`) is not the scorer the launch record pinned (`5edb89f7…`) and not the one that produced the archived rehearsal adjudication — `limits-disagree-with-baseline` was removed after the rehearsal, undisclosed in the brief (the removal itself was probably correct; the undisclosed post-rehearsal edit is the disease). Nothing re-checks scorer/observer digests at scoring; the launcher records `repo_changed_paths` (6 at the rehearsal) and refuses on nothing; at `repo_commit 01504a3` the scorer existed in no commit. | `rehearsal-3929cc7-launch-record.txt`; `scripts/rel3-soak-adjudicate.sh` (thresholds digest only); `scripts/rel3-soak-launch.sh:92-98` |
| F3 | **HIGH** | The frozen launch record's `adjudication_command` passes the run's own log as `--baseline-extra`: on a real night that guarantees INCOMPLETE (every run-phase sample trips `baseline-after-run-start`), and in the rehearsal it double-counted the 7 pre-run samples — the registered minimum of 12 was met only by duplication of 6 real measured samples. The committed adjudicate.sh uses the right source but contradicts the record, is itself unpinned, mislabels WINDOW_END as `run-end`, left `run_end` blank in the rehearsal record, and always exits 0. The scorer accepts `--baseline-extra` equal to `--telemetry` without complaint. | `scripts/rel3-soak-launch.sh:250`; `scripts/rel3-soak-adjudicate.sh:82-93`; `rehearsal-3929cc7-eligibility.json` (`baselineSamples: 14`) |
| F4 | MEDIUM | The detection boundary is honest on duration, silent on magnitude: a +0.5-core neighbour sustained across the whole window passes the median gate at exact equality (1.345 ≤ 1.345) and the mean gate with room — 120 sustained core-minutes, invisible at any duration. Plus: window holds 241 samples → rank 121 (text says 240/120); thresholds note "~2 cores" vs amendment "0.2–4.0 cores". The panel did not agree on whether the number must change; it agreed the sentence must exist. | `docs/implementation/rel3-quiet-host-thresholds.json:28-31`; `scripts/rel3-soak-eligibility.mjs:934` |
| F5 | LOW | Operator-supplied run bounds remain the unavoidable procedural residue; the scorer silently ignores samples after the claimed run-end — report them. Observer header's "fork-free" claim is false (harmless: the cost is in its own excluded cgroup). Launcher READY accepts the synthetic `interval=0` first sample. Launcher pre-check minimum 6 vs registered 12. Self-check telemetry shows the host at `foreignProcs=7` (= the registered limit, zero headroom) 50 min before a census pinning 4 — unexplained, check before the night. | `rel1-soak-telemetry.sh:38-40,249`; `rel3-soak-launch.sh:116-131,165`; `self-check-telemetry.log` |

## Bottom lines

- **Mink (instrument):** the observer and self-check I sign — every round-2 instrument finding
  is closed and proven on the host. The run does not start until F1 is fixed with an off-grid
  fixture and the rehearsal is RE-RUN with the committed scorer; evidence produced by a judge
  that was edited away afterwards is not evidence of this chain.
- **Priya (adversarial):** Q1 is NO until digest enforcement exists at scoring and launch
  (`scorer_digest`/`observer_digest` compared, `repo_changed_paths==0` required) — today the
  only enforced digest is the thresholds', and the one post-hoc edit the chain was built to
  prevent already happened, politely and for good reasons. Both lanes see the fix diff and the
  re-rehearsal before the night. The night's bounds stay operator-supplied; at minimum report
  trailing samples.
- **Sarote (operations):** fix F1 (one comparison + one fixture), F3 (generate the record's
  command from adjudicate.sh, stop passing the run's own log as baseline-extra, pin
  adjudicate.sh), add the three-line digest check, commit clean, re-rehearse once, launch. No
  further review round needed beyond showing the diff; the chain catches its own mistakes —
  that is the property worth shipping.
- **Dara (statistics):** the gates and their arithmetic are correct and correctly frozen; Q2 is
  shippable AS STATED once the magnitude sentence, 241/121, and the ~2-vs-~4-core inconsistency
  are fixed in the registered text. A registered rule whose own description miscounts its
  samples is not yet a registered rule.

**Not resolved by the panel:** whether a sub-allowance permanent neighbour is an acceptable
disclosed blind spot (Dara) or a structural door (Priya); and whether the fixes need a round-4
look from both lanes (Priya) or only the re-rehearsal record (Sarote).

## What could not be verified

- The brief's claim that the full repository suite is green with the 30 fixtures included — not
  re-run here (read-only task); the fixtures themselves were read and counted.
- (Resolved during review, strengthening F2:) the rehearsal's adjudication WAS run through
  adjudicate.sh — the archived `rehearsal-3929cc7-adjudication.txt` carries exactly the key set
  and the microsecond `window_end` that script writes — but through an EARLIER adjudicate.sh
  that used the same wrong `--baseline-extra` source as the launch record's command
  (`baselineSources[0].path` is the run's own log). So TWO components of the judging chain —
  the scorer and adjudicate.sh — were edited after the rehearsal, neither disclosed.
- The cause of `foreignProcs=7` during the self-check window vs the census's 4 — possibly
  leftovers of rehearsals 1–3; unrecorded.
- Anything about the host's state tonight: the census is point-in-time; the four pinned foreign
  services may not be the night's four.

TEAM_DONE epic-6-quiet-host-round3-claude
