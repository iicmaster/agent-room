Hold the next qualifying launch for the scorer, window and registration defects below. The relative CPU form is defensible for a narrowly stated interference budget; these files do not yet provide a trustworthy eligibility decision.

Snapshot boundary: the main dialogue assesses the initial source hashes listed near its end. During final verification, another writer changed the observer and self-check. The late-source exchange immediately before the bottom lines supersedes B1’s current status: the newline defect is repaired in that later source, with no new Linux runtime proof supplied. The scorer, launcher and thresholds remained at the reviewed hashes.

Task: epic-6-quiet-host-round2. Read-only round-table using [bmad-party-mode](/Users/ngs/.agents/skills/bmad-party-mode/SKILL.md), with John (PM), Dr Mira (measurement/statistics), Winston (Linux/runtime), and Sally (UX/evidence operations). No other agent was started. Only this flat outbox was authored. Proposed repairs below were not made because the brief forbids them.

📋 **John:** “Mira, I accept the relative FORM in Q1. Comparing a fixed pre-run baseline with the same statistic during the measured window is a legitimate prospective operating rule. If the narrow target is an additional two to three cores throughout the four hours, the proposed allowances separate that target from this baseline. Our source-executing fixture at 2.862 foreign cores throughout the window returned CONFOUNDED on both gates.

“But I cannot call +0.5 median and +0.75 mean empirically calibrated. The archived baseline never exceeds 0.975 cores. It contains no measured four-core build storm against which to validate the burst allowance. ‘The host needs this allowance’ and ‘this allowance protects the interpretation of RSS’ are different claims. I would accept the former as a stated policy choice after the instrument defects are repaired; you demand stronger evidence.”

📐 **Dr Mira:** “Yes, John. The host’s own build still competes with the soak. Calling it normal does not remove its effect. An instrument measuring aggregate residual CPU cannot distinguish the same CPU trace produced by an approved build from one produced by a second soak. Relative comparison changes the acceptance policy; it does not solve that identification problem.

“Here are actual outputs from the unchanged scorer source, using the archived 25-sample baseline, 240 synthetic minute samples, four foreign processes, and ample available memory. These are deterministic policy probes, not observed staging workloads:

| Four-hour foreign-CPU trace | Window median | Window mean | Verdict |
|---|---:|---:|---|
| 0.862 cores throughout | 0.862 | 0.862 | ELIGIBLE |
| 2.862 cores throughout: +2 throughout | 2.862 | 2.862 | CONFOUNDED |
| 1.862 for 120 consecutive minutes, 0.862 otherwise | 0.862 | 1.362 | ELIGIBLE |
| 3.362 for 60 consecutive minutes, 0.862 otherwise | 0.862 | 1.487 | ELIGIBLE |
| 4.000 for 60 consecutive minutes, 0.862 otherwise | 0.862 | 1.6465 | CONFOUNDED |

“So: yes, the allowances catch the stipulated all-window attempt-2-class load. No, they do not catch that intensity for an hour; the fourth row admits +2.5 cores for an hour. Nor does the claimed one-hour four-core storm necessarily fit: the fifth row fails. At a 0.831-core otherwise steady baseline, one hour at four total foreign cores yields about 1.623 cores, above 1.581. The corresponding budget allows approximately 57 minutes.

“The mean allowance purchases 180 additional core-minutes over four hours. Mean alone therefore permits up to 180 minutes of one extra core. The median companion narrows that, but our two-hour example still passes. The [threshold note](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/rel3-quiet-host-thresholds.json:19) understates these blind spots when it says ‘less than about a quarter’ and ‘shorter than about 37 minutes at a full core.’ Those are not this rule’s general detection boundaries. I would not approve a qualifying start on the numerical calibration presented.”

🎨 **Sally:** “And Q2 describes a gate we do not have. [The contract’s registered row](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md:190) says CPU is judged in three shapes: mean, p95, and worst rolling five-minute mean. It omits median. [The JSON](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/rel3-quiet-host-thresholds.json:12) and [the scorer’s actual comparisons](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:344) gate median and mean; p95 and rolling five minutes are reports.

“John, saying the scorer reads the JSON does not make the contract unable to drift. They have already drifted. An operator cannot tell which document’s promised protection was approved. This is **B4 — conflicting registration and incomplete custody**, not a choice to settle after the night.”

📐 **Dr Mira:** “Nearest-rank itself is fine as a specified empirical percentile: the implementation selects sorted rank ceil(p × n). The archived p95 is reproduced correctly; with 240 samples, p95 selects rank 228 and can leave the largest twelve values above it. That was precisely my previous caution. It cannot fix a reported-only statistic.

“The implementation also uses nearest-rank at 0.5, meaning the lower middle observation for an even sample count. State that convention explicitly; many readers understand ‘median’ as the average of the two middle observations.

“The rolling calculation is five consecutive ROWS, not necessarily five minutes: [lines 134–143](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:134). At variable cadence or across missing rows it has a different duration. The mean is also an unweighted row mean. A truthful fixture with 120 intervals of 45 seconds at 0.862 cores and 120 intervals of 75 seconds at 2.2 cores passes the allowed cadence tolerance and returns ELIGIBLE, mean 1.531; the elapsed-time mean is 1.69825, above 1.5807. For a core-time budget, weight by valid interval duration and define rolling windows in elapsed time.

“I still prefer a registered duration constraint on interference. John prefers accepting the host’s bursts under a median/mean budget. We have not agreed: his policy admits the hour-long contaminant in the table; my earlier rolling gate risks rejecting legitimate builds. The supplied aggregate CPU and burst-free baseline do not identify a calibrated boundary that separates those cases.”

🏗️ **Winston:** “Before either policy can matter, there is **B1 — run-owned Node processes are also counted FOREIGN**.

“[The observer](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry.sh:197) reads the newline-terminated cgroup file using `IFS= read -r -d '' cgline`. That delimiter is NUL, so the trailing newline remains in the variable. It then tests whether the complete value ENDS with `/$RUN_CG_NAME`. It actually ends with a newline, so the exclusion never matches. The census repeats the same defect at [lines 249–252](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry.sh:249).

“I executed the source-extracted read/case block without changing its classification expression:

| Input bytes for the same run cgroup | Result |
|---|---|
| `0::/agent-room-soak-fixture\n` | FOREIGN |
| `0::/agent-room-soak-fixture` without LF, control only | OWN |

“The [archive itself](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-quiet-host/self-check-telemetry.log:2) confirms the symptom: baseline foreign=4; one own idle process gives own=1, foreign=5; two own processes give own=2, foreign=6 at [sample 16](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-quiet-host/self-check-telemetry.log:16). `nodeProcs=own+foreign` double-counts the owned processes.

“With the expected seven own Node processes and four unchanged baseline processes, foreign becomes eleven, exceeding the registered limit seven. That is a deterministic prediction for the normal Linux cgroup line format, not a live twelve-hour rehearsal. It can void the next night even when the CPU accounting is correct.

“Describe the repair narrowly: parse the v2 record as a newline-delimited record and compare the full intended cgroup path exactly. Merely trimming the LF leaves a suffix comparison that can match a different parent with the same leaf name. Prove the own and foreign sets are disjoint. No repair was applied.”

📋 **John:** “Then credit the fixes that really held, Winston. This is not grounds to reopen everything. Is the old CPU arithmetic fixed?”

🏗️ **Winston:** “**D1 RESOLVED for the inspected calculation; D2 RESOLVED for a healthy, persistent run cgroup.** Busy now sums user+nice+system+irq+softirq; idle and iowait are excluded, and steal is separate. Cumulative cgroup usage removes the living-process-total reset. That matches the [kernel’s CPU field definitions](https://www.kernel.org/doc/html/latest/filesystems/proc.html#miscellaneous-kernel-statistics-in-proc-stat) and [cgroup accounting interface](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#cpu).

“I recomputed the residual across ALL archived samples, beyond the self-check’s initial four: 29 self-check intervals and 24 baseline intervals. Both had maximum residual error **0 microseconds**; logged core rounding error stayed below 0.0005. The self-check’s independent reads are useful additional evidence. They are separate observations of the same counters/formula, rather than an independent accounting technology, and the twenty-second span is not synchronized exactly to the observer’s last four samples. Its 0.40-core tolerance explains why the archive’s agreement is approximate. None of that invalidates the demonstrated correction.

“But **B2 — measurement failure is not reliably INCOMPLETE**. [The observer](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry.sh:91) silently continues if its own cgroup cannot be created/joined. Missing run accounting becomes zero at [lines 166–168](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry.sh:166); failed cpu.stat reads also return zero at [lines 103–111](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry.sh:103). A failed read followed by recovery is not a valid interval delta, and the residual’s zero clamp can conceal over-subtraction. There is no explicit validity signal that the scorer requires.

“The launcher even ignores a failed move of the runner into its cgroup with [`|| true`](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-launch.sh:108). It records unknown/zero own counts but does not refuse launch. Its minute-one check is advice printed to the operator, not an enforced check.”

🎨 **Sally:** “Winston, the dangerous connection is what the scorer does when that move fails. [Lines 216–220](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:216) make the ENTIRE telemetry log baseline if no own process is ever observed. The required `--run-start` is not used to delimit that baseline.

“Our source-executing fixture with no own processes, twenty foreign processes and three foreign cores throughout returned **ELIGIBLE**. It used those same run-window observations as its 240-sample baseline, raising its own process allowance to 23 and CPU limits to 3.5/3.75. A failed launch can therefore become its own justification. That is not an exotic hostile-input scenario; the launcher explicitly permits the triggering membership failure.

“Extra baseline inputs are also not constrained to the stated pre-run host measurement. [Lines 202–212](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:202) discard their parse problems; their timestamps, ownProcs, host, boot, observer version, cadence, overlap and identity census are not validated. A corrupt appended line was ignored and yielded ELIGIBLE. A baseline consisting of future, run-owned samples also yielded ELIGIBLE. A census has been archived, which closes ‘baseline is hearsay’; it is not read or checked by this adjudication. There is no minimum baseline duration or sample count. The JSON’s measured baseline values are descriptive metadata; the scorer recomputes its limits from whichever baseline union is supplied. Adding the launcher’s fresh fifteen-minute baseline can therefore change the advertised 1.362/1.581 limits.”

📐 **Dr Mira:** “B2 also reaches the parser and configuration. [Number('')](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:85) is zero. Empty `foreignCores=` and `foreignProcs=` therefore passed as zeros. Negative CPU and negative process counts also returned ELIGIBLE. Counts need their integer/nonnegative domain; numeric fields need nonempty finite values.

“The thresholds are parsed but not validated. In a separate synthetic configuration fixture, removing both CPU allowance fields returned ELIGIBLE at three foreign cores; the computed limits serialized as null because comparisons with NaN were false. I did not change the real JSON. This demonstrates that the promised invalid-input disposition is not enforced for invalid configuration either.”

🎨 **Sally:** “There is also **B3 — the measured time window and coverage can be false**.

“[The scorer](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:233) defaults to the LAST TELEMETRY SAMPLE. The launcher leaves the observer running after the soak. The same synthetic log with a contaminated 08:00–12:00 window returns CONFOUNDED when explicitly ended at 12:00, but ELIGIBLE if scoring defaults to the log’s end at 16:00 after four quiet post-run hours. That changes the actual question being scored.

“Even supplying the result JSON’s `endedAt` does not guarantee alignment. The [RSS evaluator](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1012) anchors to the last tracker sample. The tracker [stops before final drain and idle settling](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1656); result `endedAt` is later. Require the actual RSS sample-window boundary.

“[Coverage](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:251) counts rows and trusts each row’s declared gap. There is no chronological uniqueness or actual timestamp-delta validation. The scorer returned ELIGIBLE for 240 identical timestamps declaring gapSec=60: coverage 1.0, zero observed elapsed span. A continuous 192-minute prefix missing the final 48 minutes also returned ELIGIBLE against an explicit four-hour end. The 0.8 policy literally permits that edge loss; it does not satisfy the amendment’s claim that gapped telemetry is incomplete.

“Finally, a run-start in 2027 paired with a run-end in 2026 returned ELIGIBLE. Validate bounds, bracket the actual window with valid counters, and count covered elapsed intervals. Missing segments must not silently become measured quiet time.”

🏗️ **Winston:** “The instrument’s proof also needs narrower wording. The self-check passed its assertions, but some assertions do not establish their named property:

1. [Identity fixtures](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry-check.sh:281) add TWO foreign processes but only require the aggregate foreign count to increase and own not to increase. Our real newline defect passes those checks. Test each fixture and the own/foreign partition independently.
2. [The exit scenario](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry-check.sh:260) waits three samples, then measures another twenty seconds and averages the last four. A one-sample spike at exit can have aged out. Assert the interval bracketing exit/replacement as well as later stability.
3. [The foreign-load assertion](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry-check.sh:225) only requires expected foreign CPU ≥0.30. A baseline near 0.85 already meets that without the fixture. Verify the fixture’s independently measured CPU contribution or the controlled change.
4. [The RSS hygiene regex](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry-check.sh:314) is anchored to end-of-line, although RSS is followed by other fields. A fixture with empty RSS in its actual field position produced zero matches. All archived RSS values are zero because no server was exercised; that proves neither nonzero server discovery nor this regex.
5. [Observer selection](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry-check.sh:86) chooses the first cgroup matching a wildcard, not the observer PID’s exact group. [Observer cleanup](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry.sh:96) tries to remove its own still-populated group during EXIT and ignores failure, so repeat checks can encounter stale groups. Select the exact observer group and verify required setup/measurement failures fail the check.

“The header’s ‘per-minute sample is fork-free’ is also false: date, awk, sleep and command substitutions remain. The per-PROCESS scans now use builtins, which is the useful improvement. Subtracting the observer’s CPU corrects that accounting cost; it does not make the observer physically cost-free. Its successful cgroup membership must be checked.”

📋 **John:** “Sally, turn B4 into the smallest operational requirement, not a new framework.”

🎨 **Sally:** “One frozen, reviewable launch record suffices. The [JSON note](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/rel3-quiet-host-thresholds.json:3) promises its hash is recorded at launch; [the complete launcher](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-launch.sh:63) never records it. It also never records the claimed earlier baseline sources passed with `--baseline-extra`, nor pins observer/scorer bytes. The scorer hashes whatever thresholds exist at scoring time without comparing against a launch-time expected hash. Hashing the current file proves identity now, not prior registration.

“Bind the selected rule, observer/check/scorer bytes, baseline logs and census, exact invocation and RSS window to the attempt before launch. Preserve source hashes and the eligibility result with that attempt. Validate sufficient baseline and observer health; stop on a bad ownership partition. The named scorer now exists, but the launcher neither invokes it on completion nor supplies a complete frozen adjudication command. A separately documented, mandatory external adjudication step is acceptable; a raw harness PASS is still not qualified release evidence.

“The first baseline sample is synthetic CPU zero with gapSec=0, yet [the baseline report](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:159) includes it. Reproduction gives the advertised 25-sample mean 0.8307; excluding that non-interval leaves 24 valid intervals, mean 0.865333 and elapsed-time mean 0.865401. This biases the present limit tighter, not looser, but it is not a measurement of 25 CPU intervals. The memory floor is 8,524,218,368 bytes = **7.9388 GiB**, not 8.52 GiB; it remains above the four-GiB floor. Correct the interpretation without quietly adjusting any historical verdict.”

📋 **John:** “My minimum before a qualifying start is five bounded items; these are recommendations, not performed edits:

1. Repair exact cgroup membership and demonstrate disjoint own/foreign counts with the real seven-process run, individual foreign fixtures and process replacement.
2. Make missing accounting, invalid samples/configuration and invalid baseline inputs produce INCOMPLETE; forbid the measured window from becoming its own baseline.
3. Bind scoring to the actual RSS window; validate chronological intervals, coverage and boundaries, with elapsed-time CPU aggregation.
4. Reconcile the single CPU policy across amendment, JSON and scorer; freeze its bytes and baseline sources in the launch record, and enforce the preflight checks.
5. State the accepted detection limits accurately. If the requirement includes shorter high-load interference, calibrate that requirement on independent host burst traces before choosing thresholds.

“I would not demand another full diagnostic night solely to replace the acknowledged median/mean policy with Mira’s preferred rolling rule. After the concrete defects are fixed, I accept this relative policy for its narrower all-window +2-to-3-core target. I will not call it calibrated protection against every contaminant.”

📐 **Dr Mira:** “I still require evidence for the burst-versus-contaminant tradeoff before a qualifying night. The 25-minute archive characterizes the steady baseline; it does not establish the distribution of builds over four-hour windows or their effect on RSS. The +3 process allowance is likewise a coarse screen, not validated separation under this argv[0] classifier: renamed Node services are explicitly outside it, baseline identities are not monitored continuously, and one non-Node process can consume CPU or storage.

“Winston’s remaining storage objection from round 1 also stands. Available memory, Node counts and residual CPU do not establish absence of low-CPU storage interference or VM steal. Reporting those tails is honest; it is not proof they cannot confound this workload. I will not invent an uncalibrated replacement threshold here.”

🏗️ **Winston:** “Executed checks and evidence boundaries are explicit:

| Command/check | Result |
|---|---|
| `bash -n scripts/rel1-soak-telemetry.sh scripts/rel1-soak-telemetry-check.sh scripts/rel3-soak-launch.sh` | exit 0 |
| `node --check scripts/rel3-soak-eligibility.mjs` | exit 0 |
| `node scripts/rel3-soak-eligibility.mjs --telemetry docs/release-evidence/v0.2.0-quiet-host/host-baseline-2026-10-22.log --run-start 2026-10-22T06:18:00Z --report-baseline` | exit 0; reproduced archived distribution and thresholds digest |
| `/Applications/Xcode.app/Contents/Developer/usr/bin/git -c core.fsmonitor=false -c core.untrackedCache=false diff --name-status 3929cc7 -- server web plugin.json mcp.json package.json README.md LICENSE CHANGELOG.md` | exit 0; empty output |
| `/Applications/Xcode.app/Contents/Developer/usr/bin/git rev-parse HEAD` | exit 0; a94e0eb7469d1044a7394dc1befc4e13a1c46d44 |

“The inline Bash classification probe used the extracted observer read/case expression with newline and no-newline inputs. Its result can also be reproduced by this minimal expression-equivalent command, executed below as a verification:

```sh
printf '0::/agent-room-soak-fixture\n' | bash -c 'RUN_CG_NAME=agent-room-soak-fixture; IFS= read -r -d "" cgline || true; case "$cgline" in *"/$RUN_CG_NAME") echo OWN ;; *) echo FOREIGN ;; esac'
```

“Scorer counterexamples executed the entire unmodified module source through Node’s `vm.SourceTextModule` using `node --experimental-vm-modules --input-type=module -e <inline harness>`. Only process argv/stdout and filesystem input delivery were injected; fake writeFileSync threw if invoked. The real frozen JSON and baseline bytes were used except for the explicitly identified invalid-configuration and invalid-extra-baseline fixtures. No fixture file was created. Required sample fields were timestamp, foreignCores, foreignProcs, ownProcs, memAvailable_kB and gapSec. Controls used ownProcs=7, foreignProcs=4, memAvailable_kB=8388608, gapSec=60, an own sample at 00:01, and 240 final-window samples from 08:01 through 12:00. This exercised real scorer logic, not a substitute arithmetic implementation.

“Direct scorer fixture input through /dev/stdin was denied by the local environment, so those synthetic cases were module-level executions, not successful standalone CLI fixture runs. The real archived baseline CLI run succeeded. Separate inline Node reads recomputed all 53 archived CPU intervals. The empty-RSS regex probe returned count zero (grep exit 1), demonstrating its missed field.

“The working tree already contained owner changes to the scorer, launcher, thresholds and other documents. These are the inspected bytes, not a claim that HEAD alone contains this contract. The six primary inputs were stable across the first two hash reads. These are the initial reviewed bytes; subsequent observer/self-check changes are recorded in the late-source exchange below:

| Reviewed input | SHA-256 |
|---|---|
| scripts/rel1-soak-telemetry.sh | a96d1b5b32a7eda5e25dd05450a27861144166e92fb1093e958c8db910e98928 |
| scripts/rel1-soak-telemetry-check.sh | 4e0fe5f4a0bce2eeb65d3eb63a49eb1cac2dcd3be0c5590cc1460f2d0767f357 |
| scripts/rel3-soak-eligibility.mjs | 7f424e2907f6c1affaa711199a0c2c9fbb4f995872ba60624093c673daab324e |
| scripts/rel3-soak-launch.sh | 1cf1e23a81d511ba4a7e53a2ed77c43f678af9ada5cf47e2203a0f1b3bd49c9d |
| docs/implementation/rel3-quiet-host-thresholds.json | bc163951e17f87e78c930081339d16640f5601e251cbaca0d4bf2a8fe39246a7 |

“Amendment SHA-256: 33c7188369e4b2142d716d11bf39a9839acada0d6803d4c6b0365dcf5842c01d. Baseline log SHA-256: d38eb657ba1e6a0f81ce5374bd8d185eebe0bb7e14af604f654d48fbf4a9c723. Self-check telemetry SHA-256: b890921479dc1a5811762320fbfa4841718b0ce88f30ca38a8803451a61902dd.”

🎨 **Sally:** “What remains unverified: no SSH/live inspection of ngs-staging, no root Linux self-check rerun, no launcher rehearsal or full soak, no actual seven-process partition measurement after repair, no independent four-core build trace, and no empirical RSS sensitivity to the accepted interference budget. The archived independent measurements’ original raw endpoint reads are not retained in the supplied files, so their printed numbers cannot be independently reconstructed here; the observer residuals can.

“The earlier codex and Claude verdicts were both read. This round credits the demonstrated D1/D2 repairs but does not inherit either lane’s historical host assertions as new measurements. The candidate record matches the supplied commit, both digests and 46-file counts, and the packaged-input diff is empty. No package was regenerated and no physical REL-1 evidence was rerun; this review makes no fresh package-digest or physical-demonstration claim. Scripts, tests and docs are outside the [packager input lists](/Users/ngs/agent-skills/plugins/agent-room/scripts/package-release.mjs:45). The frozen shipped candidate was not edited.”

🏗️ **Winston — late source verification:** “The final check caught concurrent changes after this report was first saved. The later observer is SHA-256 **901d61a3b62da9ae0c2285617ecf47f16a23a94f3951246bbc247e20b05246e9**; the later self-check is **40aca4dd0f7615ce6d6338fd3331363aa6a25dacf7b785c295793ead633649bb**. These edits were not made by this review. Historical links above use the initial source line numbers; the later files have shifted.

“The later observer parses the cgroup record with the newline delimiter and compares the complete path exactly. **B1 is RESOLVED IN SOURCE in that later snapshot**, pending a fresh runtime partition demonstration. It also adds interval/cgroup/read/delta validity fields and preserves a negative residual with an invalid marker. A temporary intermediate revision lost the read-success flag in command substitution; the later 901d61a revision uses globals and direct function calls instead, so I am not carrying that intermediate issue forward.

“However, the scorer is still **7f424e2907f6c1affaa711199a0c2c9fbb4f995872ba60624093c673daab324e** and ignores all those new validity fields. I executed another fixture explicitly setting obsCgroupOk=0, obsReadOk=0, runCgroupOk=0 and deltaValid=0 on every sample: it returned **ELIGIBLE**. Thus B2 remains blocking even with the observer’s new signals. The revised self-check adds a replacement-count assertion permitting a +3 change; it still does not prove an exact own/foreign partition or fix the other listed proof gaps. The new observer also uses a command substitution for each identified Node process’s cgroup path, so the fork-free claim still does not hold.

“`bash -n scripts/rel1-soak-telemetry.sh scripts/rel1-soak-telemetry-check.sh` passed on the late source read. No live self-check or new archived telemetry from that version was inspected. The supplied thirteen-assertion transcript validates the earlier recorded run, not these subsequent bytes.”

🎨 **Sally — late source verification:** “This changes the status of B1, not the launch ruling. B2–B4 and the threshold-policy disagreement remain. The newer instrument needs its own bound self-check and baseline evidence; the old transcript cannot silently qualify changed observer bytes. This report stops at the named snapshots rather than claiming ongoing external edits are frozen.”

📋 **John — own bottom line:** “HOLD now for remaining B2–B4; require runtime proof of the late B1 source repair. Relative median/mean is acceptable after those repairs for a narrowly disclosed sustained-interference budget; I do not require Mira’s preferred tail gate as an automatic extra condition.”

📐 **Dr Mira — own bottom line:** “HOLD, including after code repair until the burst allowance is justified or the claim is narrowed and explicitly accepted. The actual rule is median+mean with reported tails, not the three-shape gate described in Q2. Nearest-rank is reproducible; the stated detection limits and numerical calibration are not established.”

🏗️ **Winston — own bottom line:** “DO NOT START with the current inspected scorer and launch path. The late observer repairs B1 in source, but explicitly invalid health flags still yield ELIGIBLE. D1 and D2 are repaired in their healthy path; the complete instrument is not proved.”

🎨 **Sally — own bottom line:** “HOLD until the operator has one consistent frozen rule, an enforced preflight, and a scorer bound to the actual RSS window and valid baseline. A green self-check label or raw harness PASS cannot supply those missing guarantees.”

TEAM_DONE epic-6-quiet-host-round2
