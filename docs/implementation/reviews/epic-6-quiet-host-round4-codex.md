Hold the twelve-hour qualifying launch. The missing precondition is that EVERY interval used to certify the RSS window must pass the accounting-health checks, including the interval closed by a sample AFTER the window ends. The current scorer still returns ELIGIBLE when that closing sample explicitly says its accounting failed. This is a reproduced source defect, not a request to change the registered CPU allowance.

Task: epic-6-quiet-host-round4. Read-only bmad-party-mode round-table using /Users/ngs/.agents/skills/bmad-party-mode/SKILL.md. John (PM), Dr Mira (measurement/statistics), Winston (Linux/runtime), Sally (UX/evidence operations). No other agent was started. The only authored file is this flat outbox. All proposed repairs below are recommendations; none was made.

📋 **John:** “Credit the closures before naming another hold. R1 is closed: deleting 14:00–14:47 from the clean synthetic log now gives INCOMPLETE, coverage 0.8, headSeconds 2880, with window-starts-late and window-cadence-violation. R2/C1 is closed for sound telemetry: samples through 18:01 with a fixed end of 18:00:30 give ELIGIBLE, coverage 1, head/tail zero, no findings. The archived rehearsal replay with Claude’s 08:15:50 end also has tailSeconds zero and no window-ends-early; its short span correctly remains INCOMPLETE.

“The required thresholds digest now works: omission exits 2 with no verdict. The four named raw-accounting contradictions and the malformed expectation, missing cadence and unknown disposition all reject in source executions. R4’s units repair works: 39 hot rows over mixed 45/75-second intervals report 48.75 minutes. Forty test blocks really are present. Winston, do not hold on the old boundary bugs after reproducing their repairs.”

🏗️ **Winston:** “I am holding on the new boundary’s validation, John. The scorer builds window from timestamps inside the bounds at scripts/rel3-soak-eligibility.mjs:929. It then builds overlapping intervals from the FULL log at :953, including a closing sample after the end, and counts them toward validIntervals/coverage at :982–1003. But health checks still iterate only window at :1103. A failed closing sample can supply the last thirty seconds of certified coverage without its failed flag being judged.

“I ran the actual scorer CLI, with /dev/stdin and the current thresholds digest, against a twelve-hour synthetic log. Bounds were 06:00–18:00:30 UTC, with one-minute samples through 18:01. Baseline and all numbers were otherwise valid. These results are independent of the VM substitution used for the broader probes:

| Native CLI specimen | Exit | Verdict | Coverage |
|---|---:|---|---:|
| All flags sound | 0 | eligible | 1 |
| Only 18:01 deltaValid changed to 0 | 0 | eligible, no findings | 1 |
| Only 18:01 runCgroupOk changed to 0 | 0 | eligible, no findings | 1 |
| Only 18:01 obsReadOk or obsCgroupOk changed to 0, separately | 0 each | eligible, no findings | 1 |
| Same deltaValid failure at 18:00 instead | 1 | incomplete, window-signal-failed | 1 |

“The last control also passed through the native CLI with monotonically increasing counters whose residual arithmetic was consistent at 100 Hz. All four failed-closing/failed-inside flag pairs were separately exercised in the unchanged scorer module. This is a synthetic rejection-contract counterexample, not evidence that the staging observer actually emitted these failures.

“**R4-A — BLOCKING.** Validate the health of every measurement consumed by an overlapping interval, including its closing sample outside the bounds. Keep the successful off-grid control. Extend that existing fixture with the failed-closing cases; they must be INCOMPLETE. No threshold, window shift, package change or new framework is needed.”

🎨 **Sally:** “And the launcher’s R5.4 closure remains partial. At scripts/rel3-soak-launch.sh:128, READY now requires interval=1, but still omits runCgroupOk. At :258–273 the partition check enforces own count, foreign limit and four sound flags, but it never reads a timestamp or compares sample age. The comment promising freshness at :255 has no corresponding check.

“I executed those predicates in isolation without running the launcher: runCgroupOk=0 still produces READY=1; a two-day-old otherwise sound row with own=7, foreign=4 still produces PARTITION_OK=1. Thus ‘a stale or otherwise wrong partition stops the run’ is not implemented. **R4-B — HIGH, still-open R5.4:** require the missing readiness signal and an actual age check on the row whose counts and signals are evaluated. The check called minute one actually sleeps 150 seconds after the earlier five-second placement wait.

“The switch to one named adjudication helper is real, and its use of the last tracker sample matches tests/soak/rel3-soak.mjs:1012 and :1657. The scorer/baseline mismatch guards, self-check digest, extra-baseline digest and completed-adjudication guard are also real improvements. But R3/C2 is only partially closed:

“The scorer guard at scripts/rel3-soak-adjudicate.sh:90 runs only when the recorded scorer digest is nonempty. The baseline guard at :95 likewise skips an absent digest or literal none. The standard new launcher supplies these fields, so I am not claiming ordinary new records omit them; I am saying missing binding is still accepted by the helper. The helper itself is not digested in the launch record. Its first-verdict protection tests only the final adjudication text file at :106: a partial attempt with an existing eligibility JSON and no final text can still be overwritten at :119.

“Finally, the helper’s last report at :154 expands TELEMETRY_LOG, whereas :22 defines TELEMETRY. Under set -u, an ordinary invocation without that inherited variable fails AFTER archiving. The isolated command bash -uc 'TELEMETRY=/read-only/telemetry.log; echo \"the adjudication command was: --telemetry $TELEMETRY_LOG\"' exits 127 with ‘TELEMETRY_LOG: unbound variable’. I did not execute the helper’s writes. The successful archive is not erased by this reporting failure, but the authoritative procedure does not finish normally. **R4-C — HIGH for provenance, MEDIUM for the reporting defect:** require the promised bindings, preserve an existing first verdict even after a partial attempt, and correct that variable before claiming the complete procedure is closed.”

📋 **John:** “Sally, the failed closing interval is sufficient to withhold this launch. I would fix that and the concrete launch/procedure gaps, commit the exact reviewed non-shipped files and use the launch checks. I do not require another statistical research programme or a new candidate cut. Your missing-digest case is a defensive gap in records outside what the new launcher normally emits; it is not proof that an intact new launch record silently uses a different scorer.”

🎨 **Sally:** “That distinction stands. I still require one bounded host rehearsal of the final committed chain before signing the night. The only archived rehearsal pins scorer 5edb89f7…, observer 919541ff… and launcher 0ec2dd9c…; all three differ from today’s bytes. Its record has no new selfcheck/extra-baseline digests, and its telemetry has no ownPids field. A fresh self-check archive arrived during this review: it now contains PASS 5g, emitted ownPids sets, and SELF-CHECK PASSED for 11:32:43–11:35:26Z. I credit that new direct-parent instrument evidence: its 32 measured intervals recompute to zero residual error at the archive’s 100-Hz arithmetic, all four health flags are sound, and emitted own-set sizes match ownProcs on every row. This is archived-data verification, not an independent live cgroup inspection. It is not a rehearsal of the revised launcher and adjudication helper, and it carries no launch-time binding of those final shell paths. You would accept focused fixes plus launch checks; I would not. That disagreement remains.”

🏗️ **Winston:** “R5.1’s production traversal is repaired in source: cgroup_tree and the own loop include descendants, matching foreign exclusion. R5.2/5.3’s CLK_TCK-derived Python factor and the new ownPids set assertion are present; absent health flags and runCgroupOk now count in the check. But its independent PID-set helper at scripts/rel1-soak-telemetry-check.sh:125–139 matches only the exact parent path, and no child-cgroup fixture is created. So the direct-parent set assertion is implemented; descendant correctness is source-inspected, not demonstrated by that assertion or by the new self-check archive. I am not declaring a live Linux failure.”

📐 **Dr Mira:** “John, the raw burst trace closes my ‘summary only’ objection. I recomputed forty measured samples: mean 0.977875, nearest-rank median 0.916, p95 1.434, max 1.966. The steady trace has nineteen measured samples, mean 0.82578947, median 0.845, p95/max 1.025, measured span 07:12:40–07:30:42Z. Excluding the synthetic first sample matters.

“But the caveats must survive quotation. The burst trace lacks the validity signals and has the defective process count; CPU plausibility is not current-instrument qualification or proof of PHP attribution. The distribution note also calls it ‘no run’ and later says a rehearsal ran inside it. The thresholds’ calibration block still has the old steady end 07:21:40 and burst 41/0.954 at docs/implementation/rel3-quiet-host-thresholds.json:58–73, despite the corrected main note/distribution. Those are documentary inconsistencies, not a reason to invent different operative limits tonight.

“The interval wording is improved, but the median implementation still selects in-window sample rows (:1112–1115); the aligned clean fixture contains 241 of them, while coverage uses 240 intervals. Treat the published approximately-half-window examples as qualified illustrations. The 180 core-minute mean allowance remains correct; it does not establish absence of RSS confounding. A sub-allowance neighbour can persist throughout, and shorter heavier interference can pass. Archiving its p95 does not make it gated.”

📋 **John:** “Mira, I still accept that disclosed finite sensitivity as an owner-selected screen for sustained attempt-2-class interference. The 2.8-core control is CONFOUNDED on both CPU gates. After engineering closure, my acceptance would mean permission to attempt a twelve-hour measurement under median ≤1.345, elapsed-time mean ≤1.576, foreign processes ≤7 and available memory ≥4 GiB. It would not mean that every neighbour is excluded or that host eligibility proves RSS causation or release readiness.”

📐 **Dr Mira:** “And I still decline that as sufficient causal qualification of RSS stability. A run may collect useful evidence under that narrow operational claim. A release quotation saying the host has been proven free of relevant confounding would exceed it. I do not request an uncalibrated replacement tail threshold.”

The source/evidence boundary for this decision is explicit:

| Executed check | Result |
|---|---|
| bash -n scripts/rel1-soak-telemetry.sh; bash -n scripts/rel1-soak-telemetry-check.sh; bash -n scripts/rel3-soak-launch.sh; bash -n scripts/rel3-soak-adjudicate.sh — each executed separately | Four exits 0 |
| node --check scripts/rel3-soak-eligibility.mjs; node --check tests/soak/rel3-soak-eligibility.test.mjs — separately | Two exits 0 |
| node --experimental-vm-modules --input-type=module -e <inline read-only harness> | 21 executions of the unchanged scorer; required digest, prefix, off-grid, raw/config rejections, units and flag-scope results above |
| Native scorer CLI via spawnSync, telemetry supplied on stdin, no --out | Nine executions: off-grid control/four failed closing flags/rehearsal replay, plus three independently generated clean/failed-closing/failed-inside cases |
| /Applications/Xcode.app/Contents/Developer/usr/bin/git --no-optional-locks diff --name-status 3929cc7 -- server web plugin.json mcp.json package.json README.md LICENSE CHANGELOG.md | Exit 0, empty output |

The VM harness used the existing fixture generators in memory, real crypto/path/url modules, mocked reads, and write functions that throw. The native executions used the actual scorer file and real filesystem reads; synthetic logs travelled only through stdin. Additional pure shell predicates reproduced the readiness/staleness admissions and the unset-variable failure. These checks neither ran the launcher nor created a test workspace.

HEAD was c14e7994bdc520de791c7db08f29d8e7d6b09c45 on main. The seven review inputs remain modified in the working tree; the quoted “frozen means committed” condition is not currently met by these revisions. The candidate record matches 3929cc74f30f1b0b1f5b989c6e9fbb9d4fed6eba and the supplied portable/Claude digests and 46-file counts. The packager’s explicit input lists exclude these review changes. No package was generated, installed or independently re-digested here.

Reviewed SHA-256 values:
    scorer      2dd0990e6f87936ead9f6008c411528e3a2eaaf7ac7c4f41d2b43b2b193b2bf8
    observer    d5316a38afdc22593ff63b11cabc593caff19dfdf07e2710d5c1a71ebd2dd2b9
    self-check  2fe129559eb433257c7d055b90eddcb6283543f13e24996b0de833aefc714e9a
    launcher    9407aa1ac82f7fcd6b090cbef9f700bd526868e0c02796f947d1764f39e0fa22
    adjudicator 928091112e756e8a67b03eb9b2199dbaec6ce21e0ec25891d9eeca6baeff492e
    thresholds  d11084774cfab82902b326983a87e5f46417245e40c8a96b05af6a8878f784b1
    fixtures    6f3caf1b56b95bbae840058e1033e8b87fd6760b5a341cda8460b5d2aa860f95

Not verified: the native forty-test suite or full suite (they create/delete temporary files), independent execution of the current root Linux self-check or a final-source launch/adjudication rehearsal, tonight’s host/cgroup/PID state or resource availability, either materialized package digest, any twelve-hour endurance result, or physical REL-1. The initial system git shim attempted a cache creation and was denied by the read-only sandbox; subsequent git checks used the direct Xcode binary. The final status check showed three externally changed self-check evidence files; they were re-read and the new PASS 5g was credited above. All seven review-source hashes remained unchanged. This reviewer wrote none of those evidence files.

📋 **John — own bottom line:** “NO to this launch while invalid closing telemetry can certify coverage. After the bounded engineering/provenance repairs and a committed registration, YES to trying the disclosed sustained-interference policy; I do not require a new statistical gate or another candidate cut.”

🏗️ **Winston — own bottom line:** “NO. Make every consumed interval’s closing measurement obey the health checks and keep the clean off-grid case eligible. The original prefix and clock-alignment blockers are closed; the demonstrated flag-scope hole is sufficient to retain the hold.”

🎨 **Sally — own bottom line:** “NO. Finish the promised readiness/freshness and binding/archive procedure, commit it, and show one bounded rehearsal of those final bytes on the host. John and I disagree over whether focused fixes plus launch checks are enough evidence.”

📐 **Dr Mira — own bottom line:** “NO to calling the current chain qualified. The raw calibration is now inspectable, and its limited provenance is explicit. Even after code repair, I accept only a narrowly labelled measurement attempt; I do not endorse the allowance as proof that relevant RSS confounding is absent.”

TEAM_DONE epic-6-quiet-host-round4
