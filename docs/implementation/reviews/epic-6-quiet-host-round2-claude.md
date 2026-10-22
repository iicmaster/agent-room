# Round-Table, round 2: the repaired instrument, the relative thresholds, and whether the night may start (`epic-6-quiet-host-round2-claude`)

**Verdict in one line:** the instrument is repaired and its proof is real — but the panel would NOT
let the run start tonight, because the adjudication layer has the same disease the instrument had
last round: the amendment and the frozen thresholds gate DIFFERENT statistics, the limits the scorer
actually applies are computed at scoring time from operator-supplied inputs rather than from the
frozen file, the "frozen" registration lives uncommitted in a dirty worktree, a silently mis-launched
run converts to a self-referential ELIGIBLE, and the thresholds file's own "known limit" sentence
understates the blind spot by roughly a factor of five. Every one of these is a docs/scripts fix —
no packaged byte moves, the candidate stays frozen.

Task: epic-6-quiet-host-round2-claude. Advisory only, read-only: no file was edited, no command that
writes was run, no agent was started. The sole authored file is this outbox.

---

## What this round verified before the voices speak

- The observer (`scripts/rel1-soak-telemetry.sh`) was re-read in full. D1 and D2 are genuinely fixed
  as described: busy = user+nice+system+irq+softirq (idle/iowait out, steal separate, guest time is
  inside `user` so nothing is double-counted); the run's CPU is the cgroup's monotonic `usage_usec`;
  identity is cgroup membership; the observer subtracts its own cgroup; the per-minute loop is
  builtin-only. The raw counters (`busyJiffies runCpuUs obsCpuUs foreignUs`) are logged so the
  arithmetic is recomputable — that design choice is right and the self-check uses it.
- The archived self-check (`docs/release-evidence/v0.2.0-quiet-host/self-check-2026-10-22.txt`) and
  its thirteen PASS lines match the checker's source; the "independent measurement" really is an
  independent read of `/proc/stat` and the cgroups, and scenario 5a's fixture really does put
  `rel3-soak.mjs` in a foreign argv[1].
- The baseline log, census and distribution were recomputed here: 25 samples, mean 0.8307, median
  0.862, max 0.975, four pinned foreign node processes — the published numbers are faithful to the log.
- The thresholds file's SHA-256 was recomputed: `bc163951…46a7`, matching the digest inside
  `host-baseline-distribution.json`.
- `git diff a94e0eb --stat`: `rel3-quiet-host-thresholds.json` (27 lines changed),
  `rel3-soak-eligibility.mjs` (89), `rel1-soak-telemetry.sh` (10), `rel3-soak-launch.sh` (6) are all
  MODIFIED and UNCOMMITTED
  relative to the last commit. `grep -rln eligibility tests/` finds nothing: the scorer has no fixture
  anywhere in the repo.
- Arithmetic on the baseline: the first sample (`gapSec=0`, `foreignCores=0.000` — a non-measurement)
  is inside the frozen mean. Mean over all 25 = 0.8307; over the 24 real measurements = 0.8653.

---

## The findings (A–G, ranked; the voices argue them below)

**A — The contract and the scorer gate different statistics.** The amendment's contract row
(`spec-6-2…amendment-2026-10-22.md:190`) says *"(c) the FOREIGN CPU in CORES, in three shapes — the
window mean, the nearest-rank p95, and the worst rolling five-minute mean — each against the MEASURED
baseline."* The frozen JSON and the scorer (`rel3-soak-eligibility.mjs:353-360`) gate **median +
mean** and list p95/rolling5m/max/minutesAboveOneCore as `reportedOnly`. The MEDIAN — the scorer's
primary sustained-interference detector — appears nowhere in the amendment. The drift the
frozen-file architecture exists to prevent ("the contract and the scorer cannot drift apart") is
present at registration, between the contract and the file.

**B — The limits the gate applies are not the frozen ones.** The scorer recomputes the baseline at
adjudication time from the log's pre-`ownProcs>0` samples PLUS any `--baseline-extra` files passed on
the command line (`:201-226, :303-309`); `thresholds.baseline.measured*` — the 0.862 / 0.8307 that
the file, the brief and the limits 1.362 / 1.581 are all quoted from — is **never read by the gate**.
It is documentation. The launch script writes neither the thresholds digest (which the JSON's own
note promises is "recorded in the attempt's launch record") nor the names/digests of any
baseline-extra source (which the JSON's baseline note promises is "named in the launch record").
Consequences: (i) the night's actual limit is decided after the night, by which files an operator
passes to `--baseline-extra` — a baseline log containing a build storm RAISES the median/mean and can
turn CONFOUNDED into ELIGIBLE; (ii) with `BASELINE_MINUTES=15` default, a single 5-minute build burst
landing inside the live pre-run window inflates the baseline mean by up to ~1 core and loosens that
night's mean limit by the same amount. The fix (described, not made): either the scorer gates against
`thresholds.baseline.measured*` and reports the live pre-run window as a cross-check, or the launch
record pins the exact baseline source set with digests and the scorer refuses anything else.

**C — The pre-registration lives in a dirty worktree.** All five contract files are modified and
uncommitted; 89 scorer lines and 27 thresholds lines changed AFTER commit `a94e0eb` — the commit
whose message is "the observer rebuilt, the self-check green, and a named scorer". `registeredAt:
2026-10-22T06:18:00Z` is a claim inside a file that has demonstrably changed since it was last
persisted, and the archived self-check output carries no digest of the observer that produced it, so
the instrument's proof is not bound to the instrument's bytes either. "Frozen" means committed, with
the commit SHA and the file digests in the launch record — not a working tree that one `git checkout`
away stops existing.

**D — A silently mis-launched run self-certifies.** The launch script moves the soak into its cgroup
with `echo $$ > …/cgroup.procs 2>/dev/null || true` (`rel3-soak-launch.sh:108`) — a failure is
swallowed. If placement fails, `ownProcs` stays 0 for the whole log, the scorer's
`firstOwnIndex === -1` branch (`:216-219`) declares EVERY sample baseline — including the measured
window — and the window is then judged against limits derived from a distribution that contains the
window itself. The verdict that comes out may be ELIGIBLE or CONFOUNDED depending on how the ramp and
hold phases shape the two overlapping distributions — but it is a THRESHOLD VERDICT on unattributed
data either way, when the only honest answer is INCOMPLETE, and nothing in the scorer can tell the
difference. The minute-one check records `ownProcs` and a note telling the operator to stop; it
does not abort, and nothing downstream re-checks. Fix: the scorer must require `ownProcs ≥ 1` on
every window sample and `ownProcs = 0` on every baseline sample (a host-characterization run gets an
explicit flag), and the launch script must verify the cgroup write and abort at minute one itself.

**E — The thresholds file's "known limit" sentence is wrong by ~5×, in the loose direction.** It
says interference "shorter than about 37 minutes at a full core can escape the mean" and "occupying
less than about a quarter of the window can escape the median". The real arithmetic: the mean
allowance is 0.75 cores × 240 minutes = **180 core-minutes** — a full-core neighbour escapes the mean
for up to ~3 hours; the nearest-rank median does not move until **more than half** the window's
samples are affected. So a 1.0-core neighbour present for ~119 of the 240 minutes passes BOTH gates,
with p95/rolling5m watching but not gating. Both lanes last round said "err tight" and each proposed
a duration-based detector (Mira: every rolling five-minute mean gated; June: p95 plus a rolling
fifteen-minute mean gated); the registered rule gates neither. The attempt-2 class (+2–3 cores
sustained) is caught, yes — but "sustained" there means most of the window, and the declared blind
spot must say so honestly.

**F — The baseline contains a synthetic zero.** The first sample (`gapSec=0`) is not a measurement,
and it is inside the frozen mean (0.8307 vs 0.8653 without it) and inside any future live baseline
(1-in-16 of a 15-minute window, ~6% depression of the mean). Direction: conservative (it TIGHTENS the
limit). But the codex lane explicitly asked for "exclude the initial synthetic 0.000 CPU entry" last
round and it was not done. The scorer should drop `gapSec=0` samples from every statistic.

**G — The judge has no proof.** The observer has thirteen archived assertions; the scorer — 400 lines
of parsing, window selection, baseline union, percentile and disposition logic, and the component
that actually decides the night — has zero fixtures. Mira's 12-minute one-core probe from round 1 is
the obvious first fixture (it must read ELIGIBLE under the registered rule — that is the declared
blind spot made executable), alongside: a breach log → CONFOUNDED, a gapped log → INCOMPLETE, an
all-`ownProcs=0` log → whatever D's fix says, and the archived baseline log → exactly the archived
distribution JSON.

**Minor, recorded once:** `dataProblems` classifies reasons by substring match on English prose
(`:364-371`) — fragile to rewording; without `--run-end` the window silently becomes "the last 4 h of
telemetry", which is NOT the memory gate's window if the observer outlives or predeceases the run —
`--run-end` from the harness's own record should be mandatory for a qualifying attempt; parse problems
inside `--baseline-extra` files are discarded silently (`:210-211`); the launch script's
`grep -c . … || echo 0` (`:94`) reintroduces the exact "`0\n0`" pitfall the self-check documents at
its own line 313; the self-check hardcodes 10000 µs/jiffy (HZ=100) where the observer uses
`getconf CLK_TCK`; `observer_cg()` picks the first `agent-room-observer-*` dir and a stale one from a
killed observer would poison the independent measurement; the observer's membership test
(`*"/$RUN_CG_NAME"`) misses child cgroups — if anything under the run ever creates a sub-cgroup its
processes read FOREIGN while their CPU stays (recursively) in the run's `cpu.stat`, splitting the two
accountings; and the observer is never stopped by anything after the soak ends.

---

## The voices

**Marek Ziegler — Linux systems engineer (owns /proc and the cgroups).**
"Credit first: the observer I called a broken ruler last round is now a ruler. Busy excludes idle and
iowait, steal is separate, guest rides inside user so there's no double count, the cgroup counter
survives the hourly reconnects, and the self-check measures the host independently instead of asking
the observer to agree with itself. The 0-µs residual recomputation is exactly what I asked for. My
remaining instrument notes are small: the sub-cgroup membership split, the stale observer-cgroup
pickup in the check, the hardcoded HZ. None blocks. What blocks, June, is YOUR layer now — the scorer
and the paperwork. And on Q1's physics: I'll say the thing nobody wants to say. The honest fix for a
host whose own deploy timer compiles PHP every time staging moves is to PAUSE THAT TIMER for twelve
hours. `systemctl disable --now` on one unit makes the host actually quiet, the absolute thresholds
everyone preferred become satisfiable, and the whole relative apparatus — baseline unions, floating
limits, declared blind spots — collapses into a number a child can audit. That's an operational
change, not a contract change, and it's reversible at dawn."

**Dr. Priya Raghavan — measurement methodologist (owns the pre-registration).**
"Marek, pausing the timer is not free: the census pinned THIS host's identity, the baseline measured
THIS host's behaviour, and a host whose services are selectively silenced for the measured night is a
different population from the one the baseline characterizes — you'd need a fresh baseline on the
quieted host and a registered note saying which units were stopped, or the 'quiet host' claim becomes
'a host we quieted', which must be disclosed either way. I don't oppose it; I oppose doing it
informally. My own findings are A, B and C, and they are one finding wearing three coats: **the
registration is not yet a registration.** A — the amendment gates mean+p95+rolling5m, the file gates
median+mean; two texts, both claiming to be the contract, disagreeing about which statistic judges
the night. That is not drift risk, that is drift, before launch. B is worse, because it's
structural: the scorer never reads `thresholds.baseline.measured*`. The quoted limits — 1.362,
1.581 — are prose. The operative limit is computed at scoring time from the pre-run samples plus
whatever `--baseline-extra` files are passed, and the launch record pins neither the thresholds
digest nor those files. The adjudication-time degree of freedom we convened to remove has been
re-introduced as a CLI flag. And C: all of it is uncommitted. A digest of a dirty worktree is a
digest of a mood. Commit, put the SHA and the digests in the launch record, reconcile the amendment
with the file, pin the baseline sources — THEN the word 'frozen' is true. Until then I refuse the
launch, and I note the refusal costs a day, not a night: every fix is docs and scripts."

**June Okafor — SRE / statistician (owns the aggregation, Q2).**
"I asked last round for p95 plus a rolling fifteen-minute mean, gated. Mira asked for every rolling
five-minute mean, gated. The registered rule gates neither — it gates the median, which neither of us
proposed, plus the window mean, and demotes every duration statistic to a report. I want to be fair
about why before I object: on THIS host the demotion argument is real. The baseline window contains
no build burst (max 0.975), so any tail limit derived from it is a limit the host's own cc1 storm
will breach on a clean night — gating my rolling-15 against this baseline WOULD void nights for the
host's own deploys. F18, one statistic further on, exactly as the brief says. So: nearest-rank,
registered — correct, Mira's interpolation point is settled properly. Median as the sustained
detector — a defensible choice I can live with. But then E: the file's own honesty clause says the
mean blind spot is ~37 minutes at a core when it is ~180 core-minutes, and says the median escape is
a quarter-window when it is half. If the owner reads '37 minutes' and signs, the owner has signed a
contract that admits a two-hour one-core neighbour — THAT, not the statistic choice, is my blocking
objection, because the loose direction here is the dangerous one: CONFOUNDED's asymmetry protects
against a too-tight gate wasting a night; nothing protects against a too-loose gate admitting a
contaminated ELIGIBLE that then gets SCORED. My proposal, in writing, pick one: (1) correct the
known-limit sentence to 180 core-minutes / half-window and have the owner ratify the blind spot at
its true size; or (2) gate one duration statistic in the only form this host permits — a BUDGET, not
a ceiling: 'minutes with foreignCores above baseline-p95 + 0.75' may not exceed N, with N sized to
the deploy timer's plausible nightly duty cycle and the sizing written down. I prefer (2); I will not
block (1) if the number is honest. Priya — and yes, a new statistic re-opens your registration. One
day, again."

**Tomas Herrera — adversarial release auditor (Q3, the refusals).**
"I tried to get a dirty night scored, and this time I succeeded twice on paper. Route one is B: run
the night, watch it confound, then hand the scorer a `--baseline-extra` log from some afternoon when
the builds were roaring; the baseline union's median and mean rise, the limits rise with them, and
CONFOUNDED becomes ELIGIBLE without touching a threshold — the JSON says extras are 'named in the
launch record' but no code writes that record entry and no code refuses an unnamed extra. Route two
is D: let the cgroup write fail — the launch script swallows it with `|| true` — and the whole log
becomes 'baseline', window included; the scorer then judges the window against itself plus an
allowance and returns a verdict — not INCOMPLETE — for a run whose CPU was never attributed at all. Both routes end in a
contaminated night being SCORED, which is the one outcome this entire apparatus exists to make
impossible. Neither needs an adversary — route two is one typo'd mount or one hardened systemd away.
So my list, in blocking order: fix D (scorer requires ownProcs≥1 across the window and 0 across the
baseline; launch verifies the cgroup write and aborts), fix B (pin the baseline sources by digest in
the launch record, or gate against the frozen numbers), fix C (commit; SHA in the record), fix A
(one text wins; the amendment currently doesn't even contain the word median), restate E at its true
size, and give the judge a test suite — G — because an unproven scorer judging a proven observer is
the same joke we laughed at last round, one layer up. Marek, your timer pause: I'd take it, AND keep
the relative gates, because a quieted host plus gates sized for a noisy one is belt and braces. But
Priya's right that it goes in the registration, not in a shell history."

---

## The panel's answers

**Q1 — Is the relative form acceptable, and are the allowances right?** The relative FORM: yes,
unanimously — on this host it is the only satisfiable form, the same F18 lesson correctly applied,
and anchoring to a measured, census-pinned baseline is the right instinct. But the IMPLEMENTATION is
not the form described: the limits float with a scoring-time baseline (B), not the frozen numbers the
file quotes, and the baseline carries a synthetic zero (F). The allowance SIZES: the median's +0.5 is
tight and sound for sustained interference; the mean's +0.75 is NOT tight — it is a 180-core-minute
budget whose own documentation claims it is a 37-minute one (E). It does absorb the host's build
storm (one hour at +3 cores lands exactly on the limit — if the nightly deploy duty cycle exceeds
that, clean nights will void, and nobody has measured that duty cycle) and it does catch the
attempt-2 class. Whether the mid-size blind spot (≈119 minutes at one core passes everything gated)
is acceptable is the owner's call to make — but only against the corrected arithmetic.

**Q2 — Is the aggregation the one we asked for?** No. Mira asked for mean + every rolling 5-minute
mean gated; June asked for p95 + rolling 15-minute mean gated, mean demoted. The registered rule
gates median + mean — a pair neither lane proposed — and demotes every duration statistic.
Nearest-rank as the registered percentile method: correct, and registering the method answers Mira's
interpolation objection properly. The median is a reasonable sustained detector the panel can accept.
What it cannot accept: the amendment text still describes mean+p95+rolling5m as the gated shapes (A),
so today there is no single answer to "what judges the night". Split, declared, unresolved: June
wants one duration-budget statistic gated (minutes above baseline-p95+0.75 ≤ N); Marek and Tomas
would rather quiet the host (pause the deploy timer, registered) than add a third gate; Priya takes
either, but only through a re-frozen registration. All four accept median+mean+honest-blind-spot as
the fallback if the owner ratifies the corrected numbers in writing.

**Q3 — What did we miss / may the run start?** The run must NOT start tonight. Blocking, in order:
**D** (self-certifying mis-launch — false-ELIGIBLE direction), **B** (scoring-time baseline freedom —
false-ELIGIBLE direction), **C** (nothing is actually frozen), **A** (two contracts disagree). Strongly
wanted before the night, not formally blocking: **E** (restate the blind spot at its true size for the
owner's signature), **G** (scorer fixtures, starting with Mira's 12-minute probe and the archived
baseline log reproducing the archived distribution), **F** (drop `gapSec=0` samples). Every fix is in
`scripts/` or `docs/` — outside the packager's inputs; the candidate `3929cc7` and the REL-1 evidence
are untouched by all of it. Estimated cost: a day of script-and-docs work plus one commit, against a
twelve-hour night that routes B or D could otherwise convert into a contaminated qualifying run.

---

## Bottom lines

- **Marek:** "The ruler is fixed and proven — thirteen assertions, zero residual. Now the clipboard
  is the broken part. Commit the paperwork, close the `|| true` hole, and seriously: pause the deploy
  timer for one night and most of this argument evaporates."
- **Priya:** "A registration that gates different statistics in its two texts, computes its limits
  from unpinned runtime inputs, and lives uncommitted is not yet a registration. Fix A, B, C and
  re-freeze — one day's work — and I'll call this contract what it wants to be: pre-registered."
- **June:** "Nearest-rank registered: good. Median as the sustained detector: acceptable. The
  known-limit sentence claiming 37 minutes when the arithmetic says 180 core-minutes: not acceptable —
  correct it and let the owner sign the real blind spot, or gate one duration budget. I'll take
  either; I won't take the current prose."
- **Tomas:** "Two paper routes turn a dirty night into a scored one — the baseline-extra flag and the
  swallowed cgroup failure. Close both, give the judge the test suite the witness already has, and
  then I'd let the night run. Tonight, no."

## What this review could not verify

- Anything requiring the soak host: that ngs-staging's HZ is 100 (the self-check assumes it and
  passed there, so probably), whether any sub-cgroup is ever created under the run's cgroup at
  runtime, the actual nightly duty cycle of the staging auto-deploy builds (the 25-minute baseline
  contains NO burst — the claim that bursts reach ~4 cores is from the brief/amendment prose, not
  from any archived sample, whose maximum is 0.975), and whether `echo $$ > cgroup.procs` succeeds
  under this host's systemd configuration.
- When the uncommitted edits to the five contract files were made relative to `registeredAt`
  06:18:00Z — mtimes and git show only that they postdate commit `a94e0eb` and remain unpersisted.
- The self-check output is archived prose; it was not re-run here (this review is read-only and the
  check needs Linux root). Its internal consistency with the checker's source was verified; its
  binding to the exact observer bytes now in the worktree cannot be, since no digest ties them.
- The codex lane's round-1 positions were taken from its archived review and the brief; its round-2
  view is its own lane's to give.

TEAM_DONE epic-6-quiet-host-round2-claude
