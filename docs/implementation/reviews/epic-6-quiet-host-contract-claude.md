# Round-Table: the corrected quiet-host contract (`epic-6-quiet-host-contract-claude`)

**Verdict in one line:** the CORRECTION is honest — made before the measured window opened, on a
measurement of the host rather than the run's outcome, with the aborted attempt archived and never
scored, and with attempt 4's FAIL untouched — but the INSTRUMENT that the corrected contract names as
its sole source is broken as committed, in a way that would mark EVERY window CONFOUNDED, and the run
must not start until it is fixed, dry-run, and the baseline it gates against is measured by the fixed
script rather than asserted. Two code defects, found by reading `scripts/rel1-soak-telemetry.sh`
against `/proc` semantics and the harness's own reconnect schedule, are the blocking findings; the
threshold design itself is sound in shape and the panel splits only on the aggregation statistic.

Task: epic-6-quiet-host-contract-claude. Advisory only, read-only: no file was edited, no command that
writes was run, no agent was started. The sole authored file is this outbox.

---

## The two confirmed instrument defects (read before the voices)

**D1 — `foreignCores` is computed against a total that includes idle and iowait.**
`host_cpu_total()` (`scripts/rel1-soak-telemetry.sh:77-79`) sums `/proc/stat` fields
`$2+$3+$4+$5+$6+$7+$8` = user, nice, system, **idle**, **iowait**, irq, softirq. `HOST_DELTA` therefore
≈ (number of cores × elapsed jiffies), and `FOREIGN_CORES = (HOST_DELTA − RUN_DELTA)/(CLK_TCK × secs)`
≈ (cores − the run's own busy cores) — on the stated 4-core host, ~3.9 every sample. Threshold (c),
mean ≤ 0.25 cores, is breached by construction; every attempt is CONFOUNDED before it begins. This is
the same failure class the correction exists to remove: a clause that can never be satisfied measures
the host, not the run. The fix (described, not made — this review is read-only): busy =
`$2+$3+$4+$7+$8+$9` (user+nice+system+irq+softirq+steal). Iowait must stay OUT of "busy": on this host
iowait IS the run's own fsync waiting, and counting it would re-import the load-average mistake under a
new name.

**D2 — `RUN_CPU` sums cumulative counters over currently-alive own pids, and the harness kills own
pids every hour.** `cpu_jiffies_of` reads lifetime utime+stime; the loop sums it over own pids ALIVE at
this sample (`rel1-soak-telemetry.sh:109-124`). The harness tears down and respawns every client child
at every reconnect window — hourly on a 12-hour run (`tests/soak/rel3-soak.mjs:84-87`,
`reconnectEveryMs` at line 304, `min(3_600_000, durationMs/8)`). When a client exits, its lifetime busy
jiffies vanish from `RUN_CPU`, `RUN_DELTA` goes large-negative, and `FOREIGN_DELTA = HOST_DELTA −
RUN_DELTA` spikes for one sample by that pid's whole lifetime of busy time divided by 6,000 jiffies —
a client that averaged even a few percent of a core for its hour produces a spurious multi-tenth-of-a-
core to multi-core spike, four clients at once, once per hour, INSIDE the measured window (hours 8–12
contain four reconnect cycles). That poisons the mean and can poison a p95. Fix: track per-pid previous
values and count a vanished pid's delta as 0 (its real final-minute delta is lost; the error is then
bounded at one minute of one process, in the conservative direction).

Supporting facts verified: the committed sidecar has never produced a line — `git log` shows its only
commit is HEAD (`198d4d3`), and no archived telemetry log carries the new fields
(`attempt5-3929cc7-telemetry.log` has `nodeProcs=` only, values 3–5, no
`ownProcs/foreignProcs/foreignCores`). The baseline "7" is asserted in the README and this gate's
brief; the amendment's own prose says "**three** long-lived node services"
(`spec-6-2…amendment-2026-10-22.md:80-82`) while the README names seven; the archived logs, counted by
the OLD method, say 3–5 TOTAL. No archived artifact shows 7. Also verified by reading the spawn sites:
the server (`rel3-soak.mjs:552-563`, entry under the world's `portableRoot`), the MCP clients
(`:698-706`, same), and the recorder (`:856-857`, argv carries `world.ackLogPath`) all name the world
directory on their command lines, and the runner matches `rel3-soak.mjs` — so the own/foreign split is
implementable as designed, PROVIDED the operator passes the world path in the same (real)path form the
harness uses (`realpathSync` at `:462`).

---

## The voices

**Marek Ziegler — Linux systems engineer (owns /proc).**
"The contract's PROSE is right and its SCRIPT is wrong. The load-clause demotion is textbook: Linux
load average counts D-state (uninterruptible I/O) tasks, so a `synchronous=FULL` store generates load
with an idle CPU — gating on it punishes fsync for existing. The foreign-cores idea is the correct
replacement because it covers NON-node neighbours too, which the process-count clause (b) never will.
But as committed, D1 makes the gate a tautology-of-failure and D2 makes the mean unusable even after
D1 is fixed, because the harness's own reconnect design detonates the accumulator hourly. Priya, your
honesty question is upstream of mine: an honest contract measured by a broken instrument still
produces garbage with a clean conscience. And one small thing for the record: the script's header
claims the answer is 'comparable across attempts' — it is not; every archived log used a different
counter. Say that plainly rather than letting the header imply continuity."

**Dr. Priya Raghavan — measurement methodologist (pre-registration).**
"On Q1 I am satisfied, and I want to be precise about why, because 'the criterion was relaxed until it
passed' is exactly what this is not. Four marks: (1) the correction was made BEFORE the window opened
and the run's memory verdict was unknowable at that moment — the correction could not have been fitted
to an outcome; (2) the aborted attempt is archived under its own name and never scored, which is the
costly option — the cheap option was to let it run and relabel; (3) attempt 4, the FAIL, is untouched
and still fails under everything amended; (4) the CONFOUNDED branch cannot manufacture a PASS — it only
voids nights. A relaxation-to-pass would loosen the MEMORY gate; this touches only the admissibility
precondition. The old clause genuinely measured the host: a criterion false on every attempt including
the one that FAILED carries zero information about any attempt. That said, Tomas is right that intent
and instrument are different questions — and I have my own pre-registration complaint: the p95 clause
exists only in this gate's BRIEF. The amendment as committed (`:133`) says 'averaged over the window'
and nothing else. Whatever the panel settles must be WRITTEN into the amendment before launch, with the
exact scoring procedure for (a)(b)(c) over hours 8–12 — there is no evaluator in the repo for the
telemetry log, so today the CONFOUNDED verdict is an awk nobody has pre-registered. An unregistered
scoring step is the next version of the hole we are here to close."

**June Okafor — SRE / statistician (owns the aggregation, Q2).**
"On Q2, with the instrument fixed: the mean alone is the wrong gate and the proposal knows it — a
neighbour burning a full core for the last 50 minutes of the window sits at mean 0.21 and passes. The
p95 companion is the right instinct, but p95 of 240 one-minute samples forgives 12 minutes of ANYTHING,
including 12 minutes of a full test suite, and Marek's D2 spikes would have eaten that allowance with
artifacts. My preferred gate is p95 ≤ 0.5 as proposed PLUS a rolling 15-minute mean ≤ 1.0 core as the
sustained-neighbour tripwire, with the window mean REPORTED, not gated — a mean is a summary for
humans, not a detector. Marek thinks the mean+p95 pair as proposed is fine once D1/D2 are fixed and
that my rolling window is a third knob nobody will calibrate; we did not converge, and I'll say why we
don't have to: the asymmetry of the outcome shape protects us. CONFOUNDED never creates a false PASS;
a too-tight threshold costs a night, a too-loose one admits a contaminated PASS. So err tight, pick ONE
form tonight, and write it down. On '+3 processes': right order of magnitude — the baseline services
respawn npm-wrapper children and jitter ±1–2, and the known contaminant class (a suite run) adds 10+,
so +3 separates the clusters cleanly. But (b) is a tripwire, not the protection: a non-node neighbour
never trips it. (a) and a FIXED (c) are the real contract; keep (b) because it is cheap and names the
attempt-2 failure mode. The numbers 0.25/0.50 on a 4-core box with 7 idle-ish services: plausible, and
unavoidably uncalibrated — the dry run and the pre-launch baseline window ARE the calibration, which is
exactly why they must be archived."

**Tomas Herrera — adversarial release auditor (Q1's worry, Q3).**
"I tried to break this three ways. First, relaxed-until-it-passes: Priya's four marks hold, and I add
the one she is too polite to state — the party that wrote the correction is the party whose release is
gated by it, and the mitigation is THIS review plus the fact that the correction cannot touch the
memory verdict. Accepted, with the note that the thresholds are author-chosen and calibration-free
until the dry run exists. Second, hiding a neighbour INSIDE the run's own bucket (Q3): to be classified
'own', a process must carry the run's world directory — a fresh random path — or the literal
`rel3-soak.mjs` on its command line. No plausible neighbour does either; an ADVERSARY could, but this
contract defends against a careless operator, not a hostile one, and the archived evidence chain makes
hostility a different conversation. Third, the reverse misclassification, and here I land a real one:
the run's own non-node children (a shell, a git call) and any node grandchild spawned WITHOUT the world
path in argv count as foreign — conservative, fine — but the bigger reverse risk is operational:
pass `WORLD` as a symlinked path while the harness realpaths it (`rel3-soak.mjs:462`) and ALL six own
processes become foreign, foreignProcs reads baseline+6, and the night is voided by an argument-passing
mistake. Cheap insurance, demand it: the first samples of the run must show `ownProcs` = 7 (runner,
server, four clients, recorder) and `foreignProcs` ≈ the recorded baseline, checked before the ramp
starts, or the operator stops then — not at hour 12. And the baseline itself: 7 is a number in prose
contradicted by the amendment's own '3 services' sentence two paragraphs up. A gate of 'baseline + 3'
where the baseline is hearsay is not pinned. Measure it with the fixed script, pre-launch, same host,
archive the window, write the number into the attempt record."

---

## The panel's answers

**Q1 — Is the correction honest?** Yes, unanimously: timing (before the window), basis (a measurement
of the host, not the run's outcome), cost (a night voided and archived, attempt 4 still failing), and
shape (CONFOUNDED can only void, never pass) all point one way. The old process clause was false on
every attempt including the FAIL, so it carried no information; removing it removes nothing that ever
discriminated. The load demotion is independently correct Linux reasoning (D-state fsync waits inflate
load at >90% idle). The dissent-shaped caveat, from Tomas: honesty of INTENT is established; honesty of
MEASUREMENT is not yet, because the named instrument has never run and is broken as committed.

**Q2 — Is the aggregation right?** Split, declared, not resolved. All agree mean-only (the doc as
committed) is insufficient and that the p95 companion must be added IN WRITING. Marek and Tomas accept
mean ≤ 0.25 AND p95 ≤ 0.50 as proposed; June would gate p95 ≤ 0.50 plus a rolling 15-minute mean
≤ 1.0 core and demote the window mean to a report. The panel agrees the disagreement is cheap: the
outcome shape (CONFOUNDED, never scored) makes a too-tight gate cost a night, never a verdict — so
pick one form, err tight, pre-register it. On "+3": right size (separates ±1–2 baseline jitter from the
10+ of a suite run); keep it, but as a tripwire — (a) and a fixed (c) carry the contract.

**Q3 — Is the classification honest?** The design is sound and was verified at the spawn sites: all
six own processes name the world directory or the runner script on their command lines, and exe-based
node recognition closes the "node inside node-versions paths" hole that broke the old counter. No
realistic neighbour can enter the own bucket. The failure directions are (i) own→foreign via a
symlink/realpath mismatch in the WORLD argument — voids a night, catchable at minute one; (ii) D2's
accumulator artifact inflating foreignCores at every hourly reconnect — a bug, not a design flaw;
(iii) the baseline pinned by assertion (7 in the README, 3 in the amendment's prose, 3–5 total in every
archived log under the old counter) rather than by an archived measurement of the new counter.

**Q4 — What the run must not start without.** Five preconditions, the first three blocking:
1. **Fix D1** — busy CPU = user+nice+system+irq+softirq+steal; idle AND iowait excluded.
2. **Fix D2** — per-pid previous-value deltas; a vanished pid contributes 0 for its exit sample.
3. **A ≥10-minute archived dry run of the FIXED sidecar** on the soak host: foreignCores plausible
   (≲0.1 with the host otherwise idle), no spike across a process exit, `serverRss_kB` never the empty
   string (the current `awk || echo 0` prints empty when the pid is gone — minor, but parsers choke).
4. **Measure and record the foreign baseline with the fixed script** in a pre-launch window on the same
   host; write the number (not "7") into the attempt record; pass WORLD as the harness's realpath; and
   check at the first samples that ownProcs = 7 and foreignProcs ≈ baseline, aborting THEN if not.
5. **Amend the amendment before launch**: the chosen (c) aggregation (p95 and/or rolling mean — one
   decision, in writing) and the exact scoring procedure for (a)(b)(c) over hours 8–12, so the night
   ends in a decision produced by a pre-registered computation, not a post-hoc awk.

None of these touches a packaged byte: the sidecar and the amendment are outside the packager's inputs,
so the candidate stays frozen. No fix was applied here because this review is read-only by its brief.

---

## Bottom lines

- **Marek:** "Right contract, broken ruler. Fix `$5+$6` out of busy and the vanishing-pid accumulator,
  dry-run it, then I'd stake the night on it."
- **Priya:** "Honest correction, properly costed and timed. But the p95 lives only in a brief and the
  scorer only in someone's head — pre-register both or we re-run this meeting in a week."
- **June:** "Gate p95 plus a rolling mean, report the window mean. If the room prefers mean+p95 as
  proposed I won't block — CONFOUNDED's asymmetry means a wrong threshold wastes nights, not verdicts.
  Err tight, write it down."
- **Tomas:** "Not relaxed-to-pass — the FAIL still fails and the abort was the expensive choice. But a
  baseline of 'seven, says the README; three, says the amendment; never measured by this counter' is
  not a baseline. Measure it, archive it, and verify the own/foreign split at minute one, or the next
  autopsy is about an argument-passing typo."

## What this review could not verify

- That ngs-staging has 4 cores, that its baseline foreign node count is 7, and the ">90% idle while
  load 1.2–3.2" figures — all asserted in the docs/brief; no archived artifact on this machine
  re-measures them (and the archived logs' `nodeProcs=3–5` come from a different, discredited counter).
- The own/foreign classification was verified by READING the spawn sites (`rel3-soak.mjs:552, 698,
  856`), not by a live sample — the committed sidecar has never produced a log line anywhere in the
  archive.
- The aborted attempt 5's own telemetry (old format) is consistent with the abort narrative (load
  1.6–2.4 late in the run, RSS 104–108 MiB, server gone after 04:51) but cannot confirm the foreign
  process count that motivated the abort, for the same counter reason.
- Whether any own node grandchildren exist at runtime that lack the world path in argv (would be
  conservatively misclassified as foreign); nothing in the harness suggests one, but only a live run
  shows the process tree.

TEAM_DONE epic-6-quiet-host-contract-claude
