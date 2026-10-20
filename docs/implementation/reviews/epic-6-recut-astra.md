Choose A for Epic 6 closure, with D as a tighter execution sequence: settle the final shipping inputs once, re-cut, repeat Story 6.3, complete a fresh eight-hour REL-3, and pass physical REL-1 on that same candidate.

Epic 6 remains IN_PROGRESS. The old soak remains a valid historical PASS for 7dc980f; it no longer qualifies the fixed release candidate. Do not relabel that run as failed, delete it, or attach its PASS to cc7eb6e.

Task: astra-recut. Reviewed checkout: cc7eb6ef3b7cec78db52e7987754fcf5e4637129. Advisory only; this outbox is the sole file created. No release action was taken. The bmad-party-mode cast is John (PM), Sally (UX), Winston (architecture, independently reviewed by Astra), Dana (release economics), and Grumbal (release assurance). Project BMAD roster/config files were absent, so this is an explicit cast using the installed skill defaults.

**What the inspection establishes**

1. The binding candidate record says a packaging-input change requires re-materialization, Story 6.3 gates, and restarting the soak. Both package forms include web/. The runner's refusal is the expected enforcement of that rule. Sources: docs/release-evidence/v0.2.0-candidate.json:6; scripts/package-release.mjs:45-46; tests/soak/rel3-soak.mjs:381-408.
2. The exact Git comparison finds two changed packaged paths between 7dc980f and cc7eb6e: web/app.js and CHANGELOG.md. The only changed executable input is web/app.js. server/, both source manifests, package.json, and the packager are unchanged. “Only web/app.js differs” is accurate for executable inputs, not for all packaged bytes.
3. The inspected soak record reports candidate-exact identity, 481.52 minutes, 22,625 acknowledged and readable messages, 47 bursts, seven reconnect cycles, passing RSS/FD rules, and no failure reasons. Both evidence files still match commit 3aec7ed. This verifies the stored record, not an independent replay of its raw message journal. Source: docs/release-evidence/v0.2.0-soak-results.md:3-59 and its JSON companion.
4. Executed: `node --test tests/viewer-app.test.mjs` → 4 pass, 0 fail, exit 0. A read-only, in-memory control loaded `git show cc7eb6e^:web/app.js` into the same existing test harness → the two envelope-dependent tests failed, the other two passed, exit 1 as expected. No file was reverted. The harness uses a DOM double, fake fetch/EventSource, and a literal envelope fixture; it does not connect to a real server or browser. Sources: tests/viewer-app.test.mjs:63-143; web/app.js:109-120.
5. REL-1 requires two physical machines, the specified vendor clients, DM and broadcast exchanges, and an authenticated live viewer showing presence and ≤5-second broadcast freshness while excluding DMs, with captured evidence. A cross-machine exchange that exposes a broken viewer is valuable discovery, not completion of that criterion. Sources: docs/epics.md:578; docs/rel1-runbook.md:216-274.

**The round-table**

📋 **John — PM:** “Choose A under the contract we actually have. B cannot close the story while openly declaring its required endurance evidence inapplicable. That is an honest interim report, but it still leaves the acceptance criterion unmet. C preserves an old soak record and gives users the viewer we know fails. Why release that artifact merely to avoid another night?”

🏗️ **Winston — architecture:** “John, the technical transfer argument deserves more than dismissal. The soak drives the server and MCP clients; those bytes and the store are unchanged. The fix unwraps one browser response. The old run still supports confidence in server endurance. Grumbal, calling all that evidence ‘void’ would be scientifically wrong. I nevertheless choose A: confidence in an unchanged subsystem and qualification of a new package are different claims.”

😤 **Grumbal — release assurance:** “I mean void as qualification for the changed candidate, Winston. I will not certify that package from another package's record. Five minutes cannot observe four hours of RSS behavior. The compressed test says exactly that: it proves machinery, not endurance. Its refusal today is a guard working, not a third flaky test. Keep that guard intact.” [tests/soak/rel3-soak.test.mjs:7-23,48-52]

🚢 **Dana — release economics:** “Grumbal, I still dispute how much new defect-detection value another eight hours buys for this diff. Much of the benefit is exact attribution and keeping a promise. Those are legitimate benefits, but name them accurately. I would not seek a policy exception just to save this overnight run: the rule was settled, and there is no supplied emergency deadline. B would require a new authorized acceptance decision, not a clever reading of today's rule. I choose A here.”

🎨 **Sally — UX:** “Dana, then spend the next few minutes where we have already found a blind spot. Before committing another eight hours, load the newly materialized viewer in a real authenticated browser. Check that boot reaches live state, presence renders, and an actual broadcast appears. The new test catches this envelope regression; its fake network and DOM cannot prove the shipped browser path. I want a bounded preflight, followed by the complete physical REL-1 after the soak.”

😤 **Grumbal:** “That extra preflight is where I disagree on scope. The minimum contractual path is the regression test, the required 6.3 gates, the full soak, then REL-1. I would not require a second manual browser session to begin the soak, especially if it consumes scarce operator time. Formal browser acceptance already belongs to REL-1.”

🎨 **Sally:** “I am not asking for two physical demos. A local browser preflight against the materialized package is enough to catch the failure that just cost us this candidate. I estimate 5–10 minutes if authentication and the test server are ready; setup time is unverified. I oppose waiting another eight hours to execute the changed user-facing path for the first time.”

🏗️ **Winston:** “Sally, that is a reasonable targeted check. I would reject turning it into a new eight-hour browser workload. The present soak does not become viewer endurance coverage by being rerun. Test the changed browser behavior directly and repeat the defined endurance profile for candidate qualification; do not invent a larger release program.”

📋 **John:** “There is also a concrete way to waste a second soak: freeze cc7eb6e, then stamp the package version afterward. The release notes currently defer the 0.1.0-to-0.2.0 stamp until after REL-1, while the packager validates a literal 0.1.0 manifest. Resolve that before freezing. If shipping requires changed manifest or packager bytes, the final candidate must be the successor containing them. If the release stamp is only an external tag, demonstrate that the packaged bytes remain identical. Do not assume the existing closeout prose grants an exception.” [docs/release-notes-v0.2.md:139-141; scripts/package-release.mjs:24-31; docs/release-evidence/v0.2.0-candidate.json:6]

🚢 **Dana:** “John, that prevention is worth more than an argument over whether to throw away the old PASS. Keep it, record that its candidate was superseded, and create new evidence separately. Avoid a fresh versioning design or unrelated cleanup. D should prevent another avoidable re-cut.”

😤 **Grumbal:** “And do not turn isolated green tests into a green suite. I accept the supplied load-sensitivity diagnosis for planning, but this review did not reproduce it. Passing alone supports that explanation; it does not establish that interference is harmless. Story 6.3 already declares noise bounds and says breaches halt. Resolve the required measurements under a recorded, controlled execution configuration with no skipped cases or relaxed thresholds.” [docs/implementation/spec-6-3-release-packaging-client-smoke-tests.md:16,34,46]

📋 **John:** “My D is therefore A with avoidable churn removed. It changes execution preparation, not acceptance. The old state record's ‘only REL-1 remains’ applied before this runtime fix and must not be read as permission to close the new candidate.” [docs/implementation/epic-6-state-in-progress.md:7,22-31]

The disagreement remains: Sally, Winston, and Dana favor the early packaged-browser preflight; Grumbal does not make it a prerequisite. Winston and Dana also assign less marginal defect-detection value to the repeated soak than Grumbal assigns to its release assurance. They have not agreed on the cheapest preparation sequence. The existing rule independently determines the required closure gates; their shared reading of that rule does not settle those disagreements.

**The minimum closure sequence recommended by John**

1. Settle the intended shipping bytes, including the viewer fix and any actual version stamp. Run the existing regression checks, resolve the reported suite failures, and perform Sally's bounded packaged-browser preflight as a recommended early check, not a new acceptance criterion. Do not start a new eight-hour run while further packaged changes are planned.
2. Re-cut once from the final commit; use cc7eb6e only if its packaging inputs are final. Preserve the old candidate/evidence in immutable history and identify the replacement explicitly. Re-materialize and freeze both new package digests and the environment. Run all five existing Story 6.3 rows: deterministic materialization, real strict Claude validation, installed Claude smoke, installed portable smoke, and SM-C1 across five fresh installs. Record the new results; retain the required cursor-reset and SM-C1 release-note content. [spec-6-3-release-packaging-client-smoke-tests.md:42-46,64-74]
3. Obtain a clean required test result on that candidate, including the five-minute validation. Keep any failed full-suite run visible alongside its diagnosis and resolving run. The short profile is an early check of the soak machinery, never a replacement for Step 4. Do not start heavy concurrent qualification work on the soak host without establishing that contention will not distort the run.
4. Complete a fresh, uninterrupted eight-hour REL-3 on the frozen candidate, with the same defined traffic, resource bounds, final drain, and identity checks. Write a fresh attempt's evidence rather than overwrite the old run. Budget at least eight tracked hours plus warmup and gate time; the supplied approximately 8.5-hour total is an estimate, not a verified end-to-end schedule.
5. Complete and verify physical REL-1 on that same fixed candidate, including the real viewer observations. Then complete the existing audit/retro and release closeout with updated candidate-specific records. The state record allocates 20–30 minutes for the human demo; availability was not verified. Keep Epic 6 IN_PROGRESS until these gates pass, and preserve the validated package bytes through publication.

**Limits of this review**

No new packages, strict validator run, full suite, churn/SM-C1 rerun, compressed soak, eight-hour soak, or real browser/two-machine demonstration was executed here. The supplied “554 tests, 552 pass, two fail” figures and separately mentioned identity refusal were not independently reconciled into one test-run total. No inference that the full suite is green is warranted. The old run's raw ack journal, host continuity, and sample statistics were not independently recomputed.

The required checked-in REL-1 bundle was absent from the expected path; this does not prove that no external demo evidence exists. Neither the supplied cross-machine encounter nor the exact remaining operator time was independently observed. The manifest-stamp conflict is verified in source, but which final stamping approach the release owner intends remains unresolved. No policy was amended.

**Each voice's own bottom line**

📋 **John:** “A, organized as D: settle all final packaged inputs, repeat 6.3 and eight-hour REL-3, complete REL-1, then close. cc7eb6e is a candidate starting point, not automatically the final freeze.”

🎨 **Sally:** “Run a brief real-browser check on the materialized fix before another night of soaking. The broken viewer rules out C as closure of the promised v0.2.0. The complete live viewer proof still belongs in REL-1.”

🏗️ **Winston:** “The old server endurance evidence remains technically useful. It does not transfer the release gate's PASS. A is required; do not expand it into an unrequested browser endurance program.”

🚢 **Dana:** “A costs another night; it need not cost another broad development cycle. Preserve the old PASS, prevent another version-induced re-cut, and do not seek a one-off exemption solely to save those hours.”

😤 **Grumbal:** “A under the settled law. I do not require Sally's additional preliminary browser session. Required gates must pass for the same final artifact; five minutes, isolated test passes, or a future patch cannot close today's Epic 6.”

TEAM_DONE astra-recut
