Hold the next qualifying launch until the telemetry accounting and run ownership are trustworthy. The correction is legitimate in principle; the supplied sidecar is not ready to qualify it.

Task: epic-6-quiet-host-contract. Read-only bmad-party-mode review, with John (PM), Dr Mira (measurement/statistics), Winston (Linux/runtime), and Sally (UX/evidence operations). No additional agent was started. The only authored repository file is this outbox. The settled memory amendment is outside this review.

📋 **John:** “Mira, Q1 is a prospective correction I would accept in principle. A permanent host service makes the original zero-foreign-node clause impossible on that host. Replacing it with an explicitly limited baseline and a CPU budget restores a usable environmental condition. The archived [attempt-5 log](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-soak-attempts/attempt5-3929cc7-soak.log:19) records the abort at 04:47:40.017Z, well before the registered hours 8–12. Its result remains aborted; attempt 4 remains a failure. Those are meaningful protections against choosing a passing outcome retrospectively.

“I cannot certify motive, nor call the new numerical allowances empirically validated. Their justification must be host interference tolerances fixed before the next launch, with no adjustment after its RSS result. The [amendment](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md:96) acknowledges the in-flight correction. That is honest disclosure. It does not make an invalid instrument valid.”

📐 **Dr Mira:** “John, the intent is defensible, but the instrument repeats the original problem. At [sidecar line 78](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry.sh:78), the aggregate is:

    user + nice + system + idle + iowait + irq + softirq

“Lines 138–143 subtract the run’s task CPU and divide by elapsed seconds. Including idle and iowait makes this approximately host capacity minus run CPU, not CPU consumed by neighbours. The [Linux kernel documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html#miscellaneous-kernel-statistics-in-proc-stat) identifies those fields and their units.

“I extracted the actual AWK expression and fed it two in-memory /proc/stat fixtures, 60 seconds apart, with 24,000 additional idle ticks at CLK_TCK=100. Result: **4.000 foreign cores on an entirely idle four-core host; correct busy foreign CPU is zero.** With a lightly loaded run this stays near four. The 0.25/0.50 contract cannot be qualified by these bytes. This is a deterministic accounting defect, not evidence that the host is busy.

“The numerator must exclude idle and iowait. For a conservative residual-busy measure, user+nice+system+irq+softirq minus properly accounted run CPU is a reasonable definition. Specify how unassigned kernel/interrupt activity is treated; the residual is not perfect causal attribution to another process. Report steal separately rather than silently treating lost VM capacity as ordinary process CPU.”

🏗️ **Winston:** “Fixing that expression alone is insufficient, Mira. [RUN_CPU](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry.sh:118) is the sum of lifetime CPU counters for the currently alive own processes. [The harness](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1920) closes all four clients and creates replacements every hour. The membership changes, so subtracting successive sums is not a valid interval counter.

“For example, previous own total 12,000 ticks and current total 1,000 produces RUN_DELTA=-11,000. Even after the host-busy formula is repaired, a 600-tick host interval would then report 11,600 foreign ticks, or **1.933 cores over a minute**, despite the illustrated workload having no foreign CPU. Conversely, admitting an existing process with accumulated CPU can over-subtract; the zero clamp can conceal that error. These numbers illustrate the code’s arithmetic; they are not observations from the staging host.

“Use cumulative accounting that survives client exit/replacement. A run-specific CPU-accounting group, where available, supplies that property. A per-process alternative must handle birth, exit and PID reuse explicitly; merely keeping a map of living PID counters still loses final CPU from exited children. Do not erase hourly reconnect intervals to make p95 pass. Prove a reconnect does not create foreign CPU before launch.”

🎨 **Sally:** “And distinguish the archived facts from the progress snapshot. The attempt-5 artifacts appeared in the specified archive during this review and were read before this verdict. The [final JSON](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-soak-attempts/attempt5-3929cc7.json:5) records aborted, candidate-exact, **130.37 wall minutes and 7,235 acknowledgements**. Its 128 RSS/FD samples span approximately 127 minutes, with RSS **91.94–122.72 MiB** and FD **22–24**. The 7,075 figure is the [04:42 progress entry](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-soak-attempts/attempt5-3929cc7-soak.log:18); 104–108 MiB and 22–23 are not the whole-run extrema.

“The signal precedes the loop-settle timeout by 60 seconds, consistent with teardown timing. It does not prove that every possible underlying fault is excluded. The final drain is pending, and the RSS evaluator says incomplete. Nothing here earns a memory or zero-loss verdict.

“The archived sidecar has 133 lines, maximum load 3.21 and minimum available memory about 8.52 GiB. It contains no ownProcs, foreignProcs, foreignCores or raw CPU counters. It cannot validate the new classifier, establish seven historical executable identities, or independently substantiate the >90%-idle claim.”

📋 **John:** “For Q2, once measurement works, I favour your proposed **time-weighted mean ≤0.25 cores AND p95 of one-minute interval averages ≤0.50 cores**. On four cores those are 6.25% and 12.5% of total capacity. They are defensible prospective operating budgets, not constants derivable from having seven services.

“The mean limits total interference; p95 catches a recurring high workload that a low whole-window mean can hide. Median alone misses workloads occupying almost half the samples. A maximum of one-minute averages makes one brief burst fatal. Keep median and maximum as reports.

“I would retain **max foreign node count ≤10**, provided baseline 7 is independently measured and frozen before launch. +3 is a coarse extra screen, not permission to call every three-process workload harmless. One CPU-heavy neighbour can be caught by the CPU rule. Baseline service CPU remains FOREIGN and included in the absolute CPU limits; do not subtract its usual usage as a second allowance.”

📐 **Dr Mira:** “I disagree with your tail tolerance, John. The pair does not generally mean ‘sustained neighbours are caught.’ My 240-sample probe had twelve consecutive one-core minutes and 228 zero minutes. Mean **0.05**, nearest-rank p95 **0.00**: both pass. Another percentile interpolation method changes the boundary value, which is why the algorithm must be registered. A full twelve-minute intrusion can be hidden by this particular pair.

“My preferred policy is **whole-window mean ≤0.25 cores AND every rolling five-minute mean ≤0.50 cores**, with p95 reported. A one-minute one-core spike contributes only 0.20 to a five-minute mean and survives; a twelve-minute one-core neighbour fails. This is a duration-based definition of sustained interference. Five minutes and 0.50 are my proposed policy, not a calibrated discovery from this archive.

“Nor does +3 identify a quiet host. Three extra idle wrappers can be harmless; a single I/O-heavy worker can matter. A departing baseline process can cancel an arriving workload in the count. I would not tighten +3 to another invented number; first archive the quiet baseline’s identities and normal restart behaviour. John accepts a coarse count budget with explicit limits. I regard that budget alone as insufficient evidence.”

🏗️ **Winston:** “Q3 has concrete false-own cases. [is_run_own()](/Users/ngs/agent-skills/plugins/agent-room/scripts/rel1-soak-telemetry.sh:58) accepts **any** command containing rel3-soak.mjs, regardless of world or parentage. Its other branch accepts the world string anywhere, without a path boundary or a required program role. The actual extracted shell function classified all three of these as own for WORLD=/tmp/run-A:

    node tests/soak/rel3-soak.mjs --out-dir /tmp/other-run
    node worker.mjs --input /tmp/run-A/unrelated
    node /tmp/run-A-sibling/worker.mjs

“They must not be excluded merely by mentioning those strings. The runner exception really is necessary: [the CLI](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:2050) creates its world internally, so its argv does not inherently contain the world path. But exempting every soak runner is not run-specific identity.

“The actual server and client entry paths are inside the materialized world; the recorder has the world’s ack-log path as an argument. Those normal cases match correctly. Missing or differently spelled WORLD, unreadable cmdline, changed process titles or path aliases can nevertheless make actual run children foreign. Failed executable reads are silently skipped, which can undercount host node processes. Recognising node by executable is the right improvement; this exact implementation still needs visibility and identity checks.

“Pin this run’s runner/server identities and start times, establish actual parent/descendant ownership, and check expected executable/argument roles. Do not rely on PID alone or substring alone. Separately pin the seven baseline service identities, executable paths and arguments with a timestamp and host/boot identity. Permit a documented restart of a known service without rebasing the count upward. New or unreadable identities must remain visible and cannot silently become own or baseline.”

🎨 **Sally:** “Q4 includes one missing operational boundary. [The registered contract row](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md:133) currently contains the mean rule, but **does not contain p95**. The proposed p95 is not yet a frozen rule in that file. Choose John’s pair or Mira’s rolling rule before launch; do not decide after seeing which one is green.

“The [harness verdict](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1711) does not ingest this sidecar or evaluate quiet-host eligibility. An external adjudication step is acceptable; silently assuming it exists is not. Name the responsible procedure and archive its inputs/result before any raw harness PASS becomes qualifying evidence. A threshold breach means CONFOUNDED/incomplete, never scored or re-scored. Missing or invalid telemetry must likewise be incomplete, never quietly interpreted as a quiet host. Preserve raw observations and independent product-fault findings even when eligibility is incomplete.”

📋 **John:** “These are the minimum launch preconditions I require; they are proposed work, not edits performed by this review:

1. **Repair and demonstrate the collector.** Correct busy-CPU arithmetic and process-lifecycle accounting; show idle ≈0, a known foreign load counted, an equivalent run-owned load excluded, and client replacement without a false spike. Include an identity fixture for another runner and a sibling world. A short Linux preflight must also measure observer overhead: this script invokes readlink per host PID, despite its comment denying per-process subprocesses.
2. **Freeze the baseline and ownership evidence.** Record the seven executable/service identities using the same classifier that will sample the run; bind this run to actual process identities and lineage, require the canonical world path, and keep baseline fixed. +3 must never become a rolling baseline that absorbs a neighbour.
3. **Freeze aggregation and coverage.** Register the chosen CPU rule, percentile algorithm, units and comparison precision. For my pair, use actual elapsed-time weights for the mean and a specified nearest-rank p95 on aligned one-minute averages. Align exactly with the harness’s measured RSS window. Exclude the initial synthetic 0.000 CPU entry, bracket the window with valid counters, and define cadence/gap coverage before launch; no zero-filling, cherry-picked omissions or post-result choice of window.
4. **Bind the eligibility decision and custody.** Name the external scoring step and missing-data disposition; pin contract/collector bytes and the launch options; use a fresh attempt destination and preserve the aborted evidence. A valid host window permits the unchanged memory/other gates to be scored. It does not itself confer PASS.

“I accept the paired mean/p95 and +3 after those conditions, with the twelve-minute limitation explicit. I do not require a new diagnostic night or a new runtime dependency.”

🏗️ **Winston:** “John, one remaining disagreement is substantive: CPU, available memory and node count do not cover foreign storage interference. A non-node disk workload can have low CPU and add no node processes. The [database](/Users/ngs/agent-skills/plugins/agent-room/server/database.mjs:137) really uses synchronous=FULL, and [Linux load accounting](https://github.com/torvalds/linux/blob/master/kernel/sched/loadavg.c) includes uninterruptible tasks. That supports reporting load rather than using it as a foreign-work meter; it does not prove all the observed load came from this run.

“I would also require evidence that concurrent storage-heavy work is excluded or attributable before calling the host quiet. Do not invent an uncalibrated disk threshold tonight. John accepts these finite resource screens under an explicit operational ban on competing heavy work; I do not consider an unverified ban sufficient. This dispute remains open.”

📐 **Dr Mira:** “Executed evidence is deliberately narrower than a qualifying run:

- `bash -n scripts/rel1-soak-telemetry.sh` → exit 0. Syntax validity did not expose the semantic CPU defect.
- No-file inline Python probes read the source, ran its extracted AWK expression and actual is_run_own shell function through stdin/arguments, and recomputed archived JSON/log summaries → exit 0. Results: idle fixture 4.000 cores; the three foreign examples all classified own; twelve hot minutes passed the mean/p95 pair. The reconnect example is illustrative counter arithmetic.
- `/Applications/Xcode.app/Contents/Developer/usr/bin/git -c core.fsmonitor=false -c core.untrackedCache=false diff --name-status 3929cc7 -- server web plugin.json mcp.json package.json README.md LICENSE CHANGELOG.md` → exit 0, empty output. HEAD inspected was 4180da518f9fb0bfc8079d2fce4bf214dbc55734 on main. The [packager input lists](/Users/ngs/agent-skills/plugins/agent-room/scripts/package-release.mjs:45) exclude scripts/, tests/ and docs/. No package was regenerated; artifact digest equality is supported here by the freeze record and attempt-5 record, not a fresh package execution.
- No soak, integration test, Linux workload, baseline census, remote-host inspection, install, commit or release action ran. Source already had owner changes; the archive and README were also being populated during review. They were preserved.

“A compact exact reproduction of the idle-fixture arithmetic, also executed with exit 0 and output 4.000, is:”

```sh
printf 'cpu 0 0 0 24000 0 0 0 0 0 0\n' | awk '/^cpu /{printf "%.3f\n", ($2+$3+$4+$5+$6+$7+$8)/(100*60)}'
```

“The extracted-source probes above additionally confirmed the expression comes from the inspected collector. The final readings use these SHA-256 identities; these are reviewed bytes, not a statement that external writers have frozen the workspace:”

| Reviewed file | SHA-256 |
|---|---|
| scripts/rel1-soak-telemetry.sh | fee9f78f70ca8591ceab85483deaf61a1fc721970b4a67344a6c90737ade8ee7 |
| tests/soak/rel3-soak.mjs | 007094827b8e181820b712b835494799eba0a8e910e935ac5a363ea0e80abcd5 |
| docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md | cb7ec460263e83886ebcf13f8c4f2e4281d5e9bb9a30eee2e95fa897b51da267 |
| docs/release-evidence/v0.2.0-soak-attempts/attempt5-3929cc7.json | b9cd396db48783041650fe4b940ac98372768f6496580bba8f26bc01d4d4ad88 |
| docs/release-evidence/v0.2.0-soak-attempts/attempt5-3929cc7-telemetry.log | 875195cc813705f3a2c56c9c49e1e5aeaba9ae4972fcc1828e060dcf643639d4 |

🎨 **Sally:** “The unverified boundaries stay visible: the seven executable identities and their presence in earlier runs; the >90%-idle measurement and attribution of waits specifically to this server; actual collector overhead and process visibility on ngs-staging; and whether either proposed CPU budget protects RSS interpretation empirically. Attempt 2’s JSON names an eight-core Darwin workstation, while attempts 4 and 5 name the four-core Linux staging host; attempt 2 is not same-host calibration of this seven-service baseline. The supplied logs do not establish that a full suite always adds ten visible children under this classifier. Future quietness, physical REL-1 behaviour and leak freedom were not tested.”

📋 **John — own bottom line:** “An honest prospective correction, not evidence that someone relaxed RSS until it passed. Hold this launch for the four concrete preconditions. Thereafter I accept mean≤0.25 plus p95≤0.50 and fixed baseline+3 as bounded operating rules; past failures and aborts keep their status.”

📐 **Dr Mira — own bottom line:** “The proposed pair is defensible only with its tail blind spot disclosed. I prefer mean≤0.25 plus every rolling five-minute mean≤0.50, and reject describing p95 as a general sustained-neighbour detector. +3 is an uncalibrated screening allowance; seven services alone validates neither that margin nor the CPU budgets.”

🏗️ **Winston — own bottom line:** “Do not launch with this sidecar. Idle/I/O-wait inclusion, reset-prone own CPU totals and substring ownership break the measurement. I additionally withhold a broad quiet-host claim until storage interference is addressed; John’s operational assurance is weaker than the attribution I require.”

🎨 **Sally — own bottom line:** “Preserve attempt 5 as aborted and unscored. Freeze one rule, one baseline, one coverage policy and one eligibility procedure before the new start. A missing sidecar or a green raw harness result cannot silently become qualified release evidence.”

TEAM_DONE epic-6-quiet-host-contract
