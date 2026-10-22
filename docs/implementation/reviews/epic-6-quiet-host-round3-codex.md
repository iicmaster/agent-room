Hold the qualifying launch. The scorer still admits a missing 48-minute window prefix and rejects a fully captured window at ordinary sample-grid offsets. The numeric limits are now committed; the complete adjudication procedure is not yet enforced as the frozen procedure described in the brief.

Task: epic-6-quiet-host-round3. Read-only round-table using [bmad-party-mode](/Users/ngs/.agents/skills/bmad-party-mode/SKILL.md): John (PM), Dr Mira (measurement/statistics), Winston (Linux/runtime), and Sally (UX/evidence operations). No other agent was started. Only this flat outbox was authored. All repairs below are recommendations; the brief prohibits making them.

📋 **John:** “First, credit what closed. The absolute CPU limits 1.345/1.576 and process limit 7 are real operative numbers now. The scorer computes the relative CPU limits for reporting, without substituting them for the registered numbers. The amendment’s CPU row now agrees with median plus elapsed-time-weighted mean. Required health flags, strict numeric parsing, explicit run bounds, chronological ordering, per-window own-process presence, and exclusion of the baseline’s synthetic first sample are substantial repairs.

“The registration was committed in `04225c5ccac57b1fab8818d2130d1161a4ae2f8f`, and the working tree was clean when inspected. HEAD advanced during this review to `c14e7994bdc520de791c7db08f29d8e7d6b09c45`; that additional commit changes only HANDOFF.md. All seven primary review hashes stayed unchanged. Do not carry round 2’s ‘uncommitted registration’ objection forward as though nothing changed.

“But Q1 has two answers: **the numbers are frozen; the adjudication path is not fully bound or correct.** Winston, give the concrete refusal before we argue about the allowance.”

🏗️ **Winston:** “There are two reproduced window defects. Either is enough to stop this launch until the scorer is corrected and the relevant existing fixtures are extended.

1. **R1 — BLOCKING: a missing 48-minute PREFIX returns ELIGIBLE.** The scorer selects only samples inside the window at [line 741](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:741), records an oversized head gap at [line 776](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:776), but never adds a data problem for that head gap. Its explicit edge rejection covers only the tail at [line 828](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:828). Delete the first 48 minutes of the measured window from an otherwise clean, continuous synthetic log: coverage becomes exactly 0.8, headSeconds is 2880, and the verdict is **ELIGIBLE, exit 0, no findings**. The large jump from the last pre-window row is outside the interval loop. This is the old missing-time problem on the opposite edge. It contradicts the amendment’s missing/gapped-telemetry disposition; 80% coverage does not excuse an unmeasured boundary.

2. **R2 — BLOCKING: a complete, bracketed log returns INCOMPLETE merely because the clocks are not aligned.** With valid samples every 60 seconds through 18:01:00, supply an RSS-window end of 18:00:30. The scorer discards the sample after the end, leaves tailSeconds=30, and compares that with the **15-second cadence tolerance**, returning **INCOMPLETE, window-ends-early**, despite having captured the interval containing the end. Coverage is 0.9958. Its error text says the registered 60-second cadence was exceeded, although only 30 seconds elapsed. The observer and tracker have separate clocks; the contract does not require their grids to coincide.

“The repair is interval-based boundary handling: use the valid samples surrounding each boundary, account for overlap with the fixed RSS window, and reject genuinely missing boundary coverage. Do not shift the window or choose a convenient end after seeing the night. Prove both missing-prefix rejection and complete off-grid-window acceptance.”

🎨 **Sally:** “Winston, the rehearsal’s INCOMPLETE label concealed another operational distinction. The [launcher’s recorded command](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-launch.sh:250) passes the entire telemetry log as its own `--baseline-extra`. The scorer [treats every extra-source row as a baseline candidate](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:657) and rejects rows after run start. A complete, quiet twelve-hour synthetic control returns ELIGIBLE without that argument and INCOMPLETE with only `baseline-after-run-start` when it is added. It also double-counts the pre-run samples: 19 measured baseline rows become 38.

“That defect is in the archived rehearsal’s reasons too; it will not disappear by waiting twelve hours. The archive reports twelve measured baseline samples because its six real pre-run intervals were supplied twice.

“However, I inspected the additional [rel3-soak-adjudicate.sh](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-adjudicate.sh:48), not just the requested file list. It already selects the last tracker timestamp and a genuinely earlier baseline file at [line 82](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-adjudicate.sh:82). A synthetic clean control using that separate archived baseline passes. So I withdraw ‘every available adjudication path is doomed.’ The actual remaining problem is **two conflicting operational instructions**: the launch record promises one invocation; the newer helper performs another. The launch record also says to take run-end from results, whereas the helper correctly uses the tracker boundary. Make one procedure authoritative before launch.”

📋 **John:** “Agreed about the conflict, Sally, but no new operational framework. Use the helper that already exists and correct its binding. What is still open on freeze itself?”

🎨 **Sally:** “**R3 — BLOCKING for the promised frozen qualification: recorded digests are not consistently required or enforced.** Three specific gaps remain:

1. The scorer’s [expected digest defaults to null](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:111), and [comparison is conditional](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:568). The adjudication helper likewise [omits the argument when the record lacks a digest](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-adjudicate.sh:75). Missing registration is therefore a successful scoring mode. A sustained 2.8-core fixture is CONFOUNDED under the real rule, but becomes ELIGIBLE when an in-memory thresholds variant raises both limits to 99 and omits the expected digest. No real file was changed.
2. The launcher records observer/scorer/launcher digests at [lines 95–98](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-launch.sh:95), but **does not record the self-check digest**. It records changed-path count without refusing a dirty or unknown registration. The helper executes the current scorer without comparing it with `scorer_digest` in the record. An unchanged thresholds file therefore does not ensure an unchanged decision algorithm.
3. The helper selects an earlier baseline file by its current repository path, without launch-time binding of that extra input. Extras no longer raise absolute CPU limits, which closes the old loophole. They can still change the baseline cross-check and hence eligibility. Existing attempt files can also be overwritten by repeated adjudication; [lines 76 and 95–121](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-adjudicate.sh:76) do not enforce the claimed preservation of an attempt’s original verdict.

“This does not demand protection against a root user forging everything. It demands that the supported workflow reject missing registration and accidental use of changed judging code. Require the launch-record digest, verify the recorded scorer bytes, include the promised self-check and selected baseline inputs, and preserve the first attempt record. All are bounded changes outside shipped inputs.”

📐 **Dr Mira:** “John, Q2’s disclosure is much better, but I still cannot endorse it as empirical protection of RSS interpretation. The 180-core-minute calculation is right relative to the stated baseline: 0.75 × 240 = 180. Equal-minute nearest-rank median is a defensible registered statistic. It catches the stipulated additional two to three cores across the whole window. It also admits an hour at an additional 2.5 cores. Our current scorer executions show that distinction:

| Synthetic foreign-CPU trace; otherwise valid host | Median | Elapsed-time mean | Verdict |
|---|---:|---:|---|
| 0.8 cores throughout | 0.8 | 0.8 | ELIGIBLE |
| 2.8 cores throughout | 2.8 | 2.8 | CONFOUNDED |
| 1.8 for 120 minute intervals, 0.8 otherwise | 0.8 | 1.3 | ELIGIBLE |
| 3.3 for 60 minute intervals, 0.8 otherwise | 0.8 | 1.425 | ELIGIBLE |
| Alternate 75 s at 1.8 with 45 s at 0.8 | 0.8 | 1.425 | ELIGIBLE |

“**R4 — the time boundary needs a qualification.** The last row contains **150 elapsed minutes** at one extra core, with full coverage and no cadence violations under the registered 45–75-second tolerance. Median is computed over sample rows at [line 853](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:853), while mean is time-weighted. The field named `foreignCoresMinutesAboveOneCore` at [line 857](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-eligibility.mjs:857) reports **120**, because it counts rows rather than minutes.

“This is an accepted-input boundary demonstrated with synthetic cadence, not an observed staging workload. The actual observer sleeps 60 seconds; I am not claiming it normally produces alternating 45/75-second intervals. State the half-window boundary in **samples**, with the approximately-two-hour interpretation conditional on one-minute spacing. Keep the registered median if that is the owner’s choice; describe its meaning accurately and give reported minutes their actual time unit.

“And the proposed alternatives are not exhausted by ‘gate these tails’ versus ‘accept all these intrusions.’ A less contended host or a prospectively registered operating schedule remains possible. I propose no uncalibrated replacement threshold here.”

📋 **John:** “Mira, the owner has deliberately chosen a coarse sustained-interference budget. I would accept that policy after R1–R3 are closed and the cadence qualification is explicit. A release gate can have disclosed finite sensitivity. I do not require every short interference event to void a night, or require a new tail gate simply because we can construct an admitted event.

“I accept your distinction: normal PHP activity still competes with the soak, and matching its CPU distribution does not prove it has no effect on RSS. My willingness to proceed is a policy acceptance, not a causal finding.”

📐 **Dr Mira:** “Then our disagreement remains. You accept the narrow budget as sufficient qualification; I require evidence that its admitted interference does not undermine the memory conclusion, or a materially narrower qualification claim.

“The steady baseline is real: I recomputed **19 measured intervals**, mean **0.82578947**, nearest-rank median **0.845**, p95/max **1.025**, and measured MemAvailable floor **7.2533 GiB**. But its actual span is **07:12:40–07:30:42**, not the **07:21:40** stated in the brief and [threshold notes](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/rel3-quiet-host-thresholds.json:48). The [distribution JSON](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-quiet-host/host-baseline-distribution.json:3) has the correct span.

“The second burst window is only summary numbers in the inspected evidence. I found no archived 41-row raw trace for 05:49:38–06:29:42 in the repository search. Its reported 0.954/0.916 would fit the limits, but I cannot independently verify its samples, synthetic-first-sample treatment, observer version, or PHP attribution. Neither a 19-interval steady baseline nor that summary establishes four-hour build duty cycles or RSS sensitivity. VM steal and low-CPU storage contention also remain outside the gated CPU/process/memory screen.”

🏗️ **Winston:** “**R5 — the instrument proof is improved, but several closure claims still exceed the implementation.** These are supporting defects and limits; R1–R3 already justify the hold.

1. **Child cgroups are excluded from foreign but not counted as own.** [Own counting](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry.sh:205) reads only the parent’s `cgroup.procs`; [foreign scanning](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry.sh:255) skips descendants. Descendant Node processes disappear from both reported counts, while parent CPU accounting includes them. The harness’s observed direct children work; descendant accounting was not proved.
2. **The self-check still hardcodes HZ in its Python recomputation.** Its independent shell measurement reads CLK_TCK at [line 77](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry-check.sh:77), but [line 255](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry-check.sh:255) still multiplies busy ticks by 10000. The claim that all self-check arithmetic reads CLK_TCK is false.
3. **There is no per-PID census/set-disjointness assertion as described.** The checker verifies each fixture’s actual cgroup and compares aggregate observer counts at [lines 408–433](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry-check.sh:408). That is stronger than round 2 and catches the newline double-counting defect, but it does not inspect observer-emitted own/foreign PID sets. The first-sample census predates those fixtures, as its own comment acknowledges. Likewise [BAD_SIGNALS](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry-check.sh:470) counts explicit zero flags, not absent flags, and omits runCgroupOk.
4. **Readiness and ‘partition’ enforcement are partial.** [READY](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-launch.sh:121) accepts the synthetic interval=0 sample and does not require runCgroupOk. The [minute check](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel3-soak-launch.sh:231) enforces only ownProcs ≥ 6; it does not check foreign count, freshness, or all validity signals. Placement failure is now enforced correctly, but ‘the complete partition is enforced’ overstates this check.
5. **The scorer trusts flags more than the raw accounting.** Separate source executions accepted backwards raw counters, interval=1 with gapSec=0, inconsistent node totals, and foreignUs inconsistent with foreignCores when flags stayed 1. Invalid configuration is not universally fail-closed either: malformed baseline expectations silently disable their checks, and setting the configured breach disposition to `eligible` yields exit 0 despite CPU-breach findings. The real frozen JSON does not contain those mutations; these are limits of the claimed invalid-input guarantee, not allegations that the archived measurements have those defects.

“I credit the observed newline repair. The rehearsal has own=7, foreign=4, total=11, and nonzero server RSS. Recomputing every archived residual gave **0 µs error** across **19 baseline, 32 self-check, and 12 rehearsal intervals** under the archive’s 100-HZ arithmetic; core rounding error stayed below 0.0005. That is useful source-bound evidence, not a Linux rerun.”

🎨 **Sally:** “The rehearsal proves less than ‘the final scorer rehearsed end to end.’ Its [launch record](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-quiet-host/rehearsal-3929cc7-launch-record.txt:11) names commit `01504a3…`, six changed paths, and scorer digest `5edb89f739564ecf7c946a225f4b11116c37f4e8c9dc896ea0403d6198371027`. The current scorer digest is `0f54e8b0d20bd63ba5e322b279b2f36ec274fa0b7c54716f04b4a6496b8cd8bf`.

“The [archived eligibility](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-quiet-host/rehearsal-3929cc7-eligibility.json:116) rejects disagreement between registered and computed limits. The current scorer intentionally reports that difference without vetoing it. Thus this is visibly an older adjudicator. The observer and launcher hashes match current bytes; credit those measurements, rather than invalidating everything because the rehearsal preceded the final commit.

“I replayed the archived telemetry through the current standalone CLI. With the same-log extra it returns INCOMPLETE with baseline-after-run-start; without that extra it additionally exposes baseline-too-small: only six real baseline intervals against the registered twelve. A short rehearsal correctly cannot qualify, but rejection alone does not establish that a complete, correctly captured night can qualify.”

📋 **John:** “The proof boundary needs to travel with the verdict:

| Executed check | Result |
|---|---|
| `bash -n`, separately on observer, self-check, launcher and adjudication helper | Each exit 0 |
| `node --check scripts/rel3-soak-eligibility.mjs` and `node --check tests/soak/rel3-soak-eligibility.test.mjs` | Each exit 0 |
| Current scorer CLI on archived rehearsal telemetry, run-start `2026-10-22T08:10:30.385Z`, run-end `2026-10-22T08:15:38.356Z`, registered expected digest; with/without same-log extra | Each exit 1, INCOMPLETE; reasons distinguished above |
| `node --experimental-vm-modules --input-type=module -e <inline harness>` | 18 executions of the unmodified scorer module; decisive results reported above |
| Direct Xcode git: `diff --name-status 3929cc7 -- server web plugin.json mcp.json package.json README.md LICENSE CHANGELOG.md` | Exit 0, empty output |

“The synthetic harness supplied process argv/stdout and filesystem reads in memory; every writeFileSync threw. It executed the complete unchanged scorer via vm.SourceTextModule, with real crypto/path/url modules. Standard fixtures used run 06:00–18:00 UTC, twenty pre-run minute rows with one synthetic first row, seven own/four foreign processes during the run, ample memory, and valid flags. The separate earlier-baseline control moved the synthetic run to 10:00–22:00 so the archived baseline genuinely preceded it. The missing-prefix probe deleted rows from the otherwise intact control. These are source-execution counterexamples, not staging observations or standalone fixture-CLI runs.

“All thirty existing tests were read and counted. Their clean windows line up with the minute grid; they cover missing tail and interior gaps, but not the rejected off-grid control or accepted missing-prefix case above. **The test suite was not rerun:** its fixtures create and delete temporary files, which this brief prohibits. The claimed 616-pass suite result remains supplied evidence. No root Linux self-check, live host inspection, new soak, or physical REL-1 rerun was performed. The initial system git shim attempted a cache creation that the sandbox denied; subsequent git checks used the direct Xcode binary.

“The candidate record matches commit 3929cc7, both supplied tree digests, and 46 files per package. The packaged-input diff is empty, and [the packager’s lists](/Users/ngs/agent-skills/plugins/agent-room/scripts/package-release.mjs:45) exclude these review targets. No artifact was regenerated or re-digested here.”

🎨 **Sally:** “For a repeatable source boundary, these are the reviewed SHA-256 values:

| Input | SHA-256 |
|---|---|
| Observer | `919541ff26e7f297f8215fbae1bd458e4fbc731cc0dbf570a8f403ae9d287228` |
| Self-check | `b2c9ae30abe247ff86d1f4650450ed4505bf61494efed7d15e315a246759f37a` |
| Scorer | `0f54e8b0d20bd63ba5e322b279b2f36ec274fa0b7c54716f04b4a6496b8cd8bf` |
| Launcher | `0ec2dd9cbcaf6c073a797c56b40977e39d573543e62adc4359fdc61aa5817e7a` |
| Thresholds | `ccb4bcaee02fd71ad45f211422c2bd2d26f9c95d7878c21f476573c08582b358` |

“Test file: `6516504d1dd1f196d79323882dd1811abf9435c213e747ae235d85817b6f9ce6`; amendment: `ecc9c782fc1fd7d07755fdbd742c1f29e3c5d787d66bfe33933bb92ca9fb69e6`; adjudication helper: `b98a01ab65a1cd6721d5ea40495f61500cc896047ed876ab990fbf3bb67838da`. Both round-2 verdicts and every file in the named quiet-host evidence directory were inspected.”

📋 **John — own bottom line:** “HOLD for R1–R3. After bounded window/binding repairs and accurate cadence disclosure, I accept median plus time-weighted mean as the owner’s narrow sustained-interference policy. I do not require a replacement tail gate or a candidate recut for these non-shipped changes.”

📐 **Dr Mira — own bottom line:** “HOLD. The disclosure now gets the 180-core-minute arithmetic right, but the approximate two-hour boundary assumes uniform sampling and the second calibration trace is not independently inspectable. Even after code repair, I do not share John’s confidence that the admitted interference is sufficient qualification of RSS stability.”

🏗️ **Winston — own bottom line:** “DO NOT START the qualifying run with this scorer. A missing 48-minute prefix is ELIGIBLE and a complete off-grid window can be INCOMPLETE. The observer’s central CPU and direct-process partition repairs have credible archived evidence; the remaining source/proof mismatches do not disappear behind a green self-check.”

🎨 **Sally — own bottom line:** “HOLD until one recorded procedure uses the actual RSS boundary, rejects missing registration, and verifies the judging bytes it promised. The newer adjudication helper fixes part of the old command, but the launch record and final-source rehearsal still disagree. A finished advisory review is not permission to start the night.”

TEAM_DONE epic-6-quiet-host-round3
