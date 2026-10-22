**Hold v0.2.0 under the existing REL-3 gate.** The endpoint statistic is demonstrably phase-sensitive, but the supplied final run also fails the regression check. Neither failure identifies a leak, and the supplied observations do not establish harmless GC phase. A prospective measurement amendment is defensible; another unchanged run whose purpose is a different phase is not. A harness-only amendment does **not** require a candidate re-cut.

Task: epic-6-soak-rss-final. Advisory review; no gate, candidate, product code, release evidence, or release status was changed. The sole authored file is this outbox.

Using [bmad-party-mode](/Users/ngs/.agents/skills/bmad-party-mode/SKILL.md), with John (PM), Sally (UX/operator experience), Mara (statistics), Nikhil (V8/Linux memory), and Quinn (release integrity). Project BMAD resolvers are absent; the roster script could not run with the available Python's missing tomllib. This is an explicitly selected cast, not a claimed saved-roster resolution.

**Evidence boundary:** The candidate record really names `3929cc74f30f1b0b1f5b989c6e9fbb9d4fed6eba`, the two supplied full tree digests, and 46 files per package. However, the requested canonical soak JSON/MD still record Attempt 1's PASS for `7dc980f`; the attempts directory contains Attempt 2, partial Attempt 3, its telemetry, the mint diagnostic, and their index. It contains no completed final `3929cc7` run or its sidecar. Accordingly, the 482.66-minute run, 23,080-message reconciliation, FD drift 1, quiet host, new memory maps and final ratios below are **user-supplied evidence, not independently replayed final-run evidence**. That gap limits authentication, not the conditional release judgment. [candidate](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-candidate.json:6), [canonical result](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-soak-results.json:23), [attempt index](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-soak-attempts/README.md:7).

📋 **John:** “Keep this run FAIL on the record and hold release. Mara, answer the measurement question without promoting a plausible GC story into a release exemption.”

📐 **Mara:** “The rule measures **change in sampled resident process memory**. It does not measure object reachability. So the proposed choice—‘leak or GC phase’—cannot be settled by this observable alone. Endpoints are sensitive to phase; raw-RSS regression reduces that sensitivity but does not identify the mechanism either. The evaluator implements the documented conjunction correctly: endpoint growth AND regression-implied growth must each be at most 2%.” [evaluator](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:974).

📐 **Mara:** “I tested the endpoint objection rather than assuming it. Feed the actual evaluator a stationary 100–107 MiB sawtooth, repeating every 25 minutes, with 240 one-minute observations. Enumerating all 25 integer phase offsets produces **14 PASS and 11 FAIL**. Endpoint growth ranges from −3.109% to +4.083%; regression-implied growth stays between −0.199% and +0.214%. That is a concrete counterexample to phase-invariant acceptance of stable periodic RSS. These are imposed offsets in an illustrative control—not a probability model for this server, not an estimated coin-flip rate, and not an explanation of this run.”

🔬 **Nikhil:** “Mara, that distinction matters. Your stationary control's OLS stays far below the supplied run's **+3.988%**. We cannot dismiss that result with the endpoint demonstration. And the brief's ‘flat post-GC floor’ is not verified: 106.9 → 111.0 MiB is **+3.84% in 25 minutes**. Both quoted troughs, 16:49Z and 17:14Z, precede the stated final-window start around 17:16Z. The hourly table stops at h18; the run ends around 21:19Z. None of that establishes the last four hours' post-collection behavior.”

🎨 **Sally:** “And ‘the only settled measurement is the instant the clients closed, with no collection since’ is contradictory. The function samples immediately; it has no GC or stabilization test. The final sample follows a complete readback/verification drain, then client closure, then the RSS read. **201.2 MiB is immediate post-drain RSS.** It proves neither a settled 201.2 MiB live set nor harmless reclaimable garbage. Cold-start 64.8 MiB was sampled before clients and warmup; those are different workload histories.” [sampler](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:612), [cold snapshot](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1313), [drain](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1436), [final snapshot](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1452).

🔬 **Nikhil:** “The hourly description also needs correcting: the zero-client sample happens **before** that reconnect's token-eviction mints and resumption, immediately after closing clients. Zero connected clients does not empty the server's registries or certify GC. The code's later ‘settled’ four-client sample is simply taken after a two-second wait; that label is not collection evidence.” [reconnect sequence](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1669).

🔬 **Nikhil:** “Your three map snapshots do support one narrow fact: RSS minus anonymous memory is exactly **53,076 KiB** in all three. Their observed short-term RSS increase is anonymous. But **anonymous is not synonymous with JavaScript heap**: it includes non-file-backed native allocations too. Transparent huge pages describe backing within memory, not a separate live-object category. Node distinguishes RSS, V8 heap, and external allocations; it also documents sustained Linux RSS growth from allocator fragmentation despite stable heapTotal. Neither ‘each major GC raises the ceiling’ nor ‘these drops are major GC’ was measured here.” [Linux memory accounting](https://www.kernel.org/doc/html/v6.8/filesystems/proc.html), [Node 24 memory accounting](https://nodejs.org/docs/latest-v24.x/api/process.html#processmemoryusage).

🧪 **Quinn:** “That leaves a legitimate RSS requirement even if the live JavaScript heap eventually proves stable. A process can consume more resident memory without leaking reachable JS objects. The product currently promises RSS stability. Calling this statistic a leak detector overclaims its meaning; it does not automatically invalidate the resource requirement.”

🧪 **Quinn:** “Also, the supplied FAIL is not just a 0.24-point near miss:

| Predicate | Supplied growth | Bound | Excess |
|---|---:|---:|---:|
| Endpoint | 2.239% | 2% | 0.239 percentage points |
| Regression-implied | 3.988% | 2% | 1.988 percentage points |

The generic failure text names ‘total growth’ whenever the combined RSS result fails. It does not say that only endpoints failed. **Removing the endpoint predicate still leaves this run FAIL.**” [failure reporting](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1204).

📋 **John:** “The archived reviews do not collectively establish Attempt 2's cause as contention. Astra expressly leaves host versus product unproved. AGY records disagreement over that causal explanation. The attempts README even claims contention proved at line 11, then says the cause is not established at lines 47–53. A superseded 191-minute quiet run is not a controlled causal proof about the failed eight-hour run. We should retain those disagreements, not rewrite their history.” [Astra limits](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/reviews/epic-6-soak-rss-astra.md:54), [AGY disagreement](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/reviews/epic-6-soak-rss-agy.md:190), [README causal claim](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-soak-attempts/README.md:11), [README uncertainty](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-soak-attempts/README.md:47).

📐 **Mara:** “John, the earlier PASS is not a calibration of the rule either. It belongs to another frozen candidate on macOS. Its actual recorded endpoints are **74.953 → 52.859 MiB**; the brief's 78.6 → 55.4 figures are decimal MB. Even a repeat of identical code can pass or fail a phase-sensitive endpoint statistic. Conversely, a downward window does not prove absence of a leak. I favor **B before another qualification** because we now have a demonstrated measurement-design weakness, independent of whether this new trace would turn green.”

🔬 **Nikhil:** “I disagree about approving a replacement gate now. We have demonstrated endpoint sensitivity, not validated a replacement observable. The smallest honest **observation change** is to retain RSS and collect natural major-GC events with used/total heap before and after each event. A harness-owned `--trace-gc` launch can do that without changing package bytes. The current child-output capture keeps only rolling tails, so durable full-event recording is necessary. Pin the flags, Node/V8 version, harness hash and workload timing; account for instrumentation effects. Do not introduce forced GC into qualification.” [child launch and output capture](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:523), [Node's GC trace fields](https://nodejs.org/learn/diagnostics/memory/using-gc-traces).

🔬 **Nikhil:** “A candidate diagnostic is a trend in **used heap immediately after confirmed natural major GCs**, at comparable capped-load/workload states over the final window. Enough events must cover the window; insufficient coverage means inconclusive. That estimates reachable heap at those collections, not permanent retention, and it does not cover every native allocation. Post-GC RSS alone still includes allocator-reserved pages. No formula over the existing RSS-only series can recover the missing live-heap information.”

📐 **Mara:** “I accept those limits; I still want the measurement contract amended before buying another eight-hour qualification. The **smallest literal PRD alignment** would make endpoint growth diagnostic-only and retain the specified OLS band. But that narrow amendment neither rescues this run nor distinguishes garbage from retained objects. For a retention-oriented replacement, first specify the baseline, window, event selection, denominator, coverage requirement and missing-data outcome. Validate stable periodic controls at different phases and growing controls—including late steps and native growth. Do not automatically transplant the RSS 2% threshold to a heap metric with a different denominator. A median, lower envelope or per-hour minimum is not a demonstrated substitute.”

🧪 **Quinn:** “And the source documents disagree. FR-13 says the single OLS band and prohibits stricter or looser story criteria; Story 6.2's implementation spec explicitly prescribes endpoint AND OLS. AGY's Dana called the extra endpoint unratified; the implementation spec says otherwise. This needs an explicit requirements ruling, not a silent evaluator ‘bug fix.’ My objection to B now is the missing validation and changed resource promise, not a blanket ban on learning from a failed test.” [FR-13](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:239), [ratified implementation](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/spec-6-2-rel-3-the-formal-soak.md:34), [archived dispute](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/reviews/epic-6-soak-rss-agy.md:184).

🎨 **Sally:** “Quinn, keep that objection finite. I support B prospectively, with four concrete conditions before its qualifying run:

1. Preserve the final run's original FAIL and archive its actual raw result and sidecar under its own attempt identity.
2. Decide whether the release promise remains resident-footprint stability or changes to retained-state stability; document the requirements ruling.
3. Specify and calibrate the chosen measurement. Keep raw loaded RSS and native-memory evidence visible; missing required collection/coverage evidence cannot become PASS.
4. Run one fresh uninterrupted eight-hour qualification with the candidate digests and amended protocol independently pinned.

Do not call a GC-instrumented diagnostic the original qualification. Do not rerun until a favorable phase appears. The existing five-minute test validates machinery, not eight-hour endurance.” [attempt preservation](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-soak-attempts/README.md:3), [calibration requirement in prior review](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/reviews/epic-6-soak-rss-astra.md:44), [compressed-test limit](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.test.mjs:19).

📋 **John:** “Yes to changing a bad measurement prospectively; no to declaring it corrected because it stops blocking release. **A is today's disposition; B is the defensible prospective path if the owner changes the contract explicitly.** The earlier AGY John's condition for a narrow endpoint amendment was a quiet run passing OLS while failing only endpoints. These supplied numbers do not meet it.” [earlier condition](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/reviews/epic-6-soak-rss-agy.md:210).

🔬 **Nikhil:** “As for ‘what is the server retaining?’—we cannot name an unbounded retainer from this evidence. Source proves expected bounded retention: session records capped at 1,000, and a separately bounded superseded-session map. The redundant `[...sessions.entries()].find(...)` after the expiry sweep creates temporary allocation work; it is not proof of per-message retention. SQLite/native allocation and allocator reservation remain possible contributors, not diagnosed defects. The old mint probe supports reclaimable allocation under its own conditions and expressly lacks heap counters and GC events. No speculative production fix is warranted.” [session capacity and allocation](/Users/ngs/agent-skills/plugins/agent-room/server/api/session.mjs:77), [superseded-map cap](/Users/ngs/agent-skills/plugins/agent-room/server/api/session.mjs:138), [capacity constant](/Users/ngs/agent-skills/plugins/agent-room/server/constants.mjs:452), [mint-probe limits](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-soak-attempts/rss-diagnostic-mint-probe.md:46).

🧪 **Quinn:** “Question 3 has a clear answer: **no candidate re-cut solely for a change confined to the soak harness and unpackaged specification/evidence.** The packager's explicit input lists exclude `tests/` and `docs/`; it copies only the declared entries. The freeze law voids the candidate when shipped inputs change. The next materialization should still reproduce these frozen identities:

| Package | Files | SHA-256 tree digest |
|---|---:|---|
| Portable | 46 | `3d90129b434b3b7adb9b4b6d8c05ed28b5a8fbf7b07951726c322cc438cf3999` |
| Claude Code | 46 | `e481c9a46ea5e14865119503e6d327df3993b29a28b325eb9eee9421def2f47b` |

Existing REL-1 evidence remains attached to those bytes, within its documented scope; a harness amendment alone supplies no reason to repeat it. The bundle records real vendor hosts driven programmatically and its other limits. I inspected that record; I did not rerun the demonstration.” [package inputs](/Users/ngs/agent-skills/plugins/agent-room/scripts/package-release.mjs:45), [copy operations](/Users/ngs/agent-skills/plugins/agent-room/scripts/package-release.mjs:229), [freeze binding](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-candidate.json:6), [REL-1 candidate binding](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-rel1/VERIFICATION.md:3), [REL-1 limits](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-rel1/VERIFICATION.md:120).

🧪 **Quinn:** “But ‘does not void the soak’ needs qualification. The old run remains valid historical evidence **as FAIL under its original protocol**. It cannot become qualification under an amended rule by relabeling or retrospective scoring. New measurement coverage that was never collected cannot be reconstructed from RSS. Record the new protocol separately from the unchanged candidate, then obtain fresh qualifying evidence. Any fix touching packaged runtime or packaged documentation changes that answer and invokes the freeze law.”

📐 **Mara:** “Quinn and Nikhil still want observation and calibration before approving a replacement gate. I want an explicit move to B now because endpoint phase sensitivity is already demonstrated. We do not agree on when the amended contract can be adopted. What remains unresolved is whether v0.2.0 must preserve the existing resident-footprint promise or explicitly replace it with a calibrated retention promise. These files and supplied samples cannot decide that product choice or prove the GC explanation.”

**Executed verification and limits**

The exact read-only command below ran with Node v24.18.1. It extracts and executes the actual evaluator without starting the soak, reuses the existing OLS helper, and asserts complete equality with each stored completed verdict. Result: **2/2 exact replays passed**—Attempt 1 −29.476756% endpoint / −12.592553% OLS, PASS; Attempt 2 +170.030738% / +213.808709%, FAIL. The illustrative stationary control returned the phase results quoted above.

```sh
node --input-type=module -e 'import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { leastSquaresSlopeBytesPerMs } from "./tests/harness/leak-tracker.mjs";
const path="tests/soak/rel3-soak.mjs";
const source=readFileSync(path,"utf8");
const body=source.slice(source.indexOf("function evaluateFinalWindowRss("),source.indexOf("\nfunction evaluateFdStability("));
const evaluate=new Function("leastSquaresSlopeBytesPerMs","FINAL_WINDOW_GROWTH_BOUND",body+"\nreturn evaluateFinalWindowRss;")(leastSquaresSlopeBytesPerMs,0.02);
for(const file of ["docs/release-evidence/v0.2.0-soak-results.json","docs/release-evidence/v0.2.0-soak-attempts/attempt2-89c8477.json"]){
 const d=JSON.parse(readFileSync(file,"utf8"));
 const r=evaluate(d.samples.data,d.schedule,true);
 assert.deepEqual(r,d.rules.finalWindowRss);
 console.log(JSON.stringify({file,exactReplay:true,growthRatio:r.growthRatio,impliedGrowthRatio:r.impliedGrowthRatio,pass:r.pass}));
}
const cases=Array.from({length:25},(_,phase)=>evaluate(Array.from({length:240},(_,i)=>({atMs:i*60000,rssBytes:(100+7*((i+phase)%25)/24)*2**20})),{finalWindowMs:14400000},true));
const range=field=>[Math.min(...cases.map(x=>x[field])),Math.max(...cases.map(x=>x[field]))];
console.log(JSON.stringify({control:"illustrative fixed 25-minute sawtooth 100-107 MiB; offsets are not probabilities",passOffsets:cases.filter(x=>x.pass).length,failOffsets:cases.filter(x=>!x.pass).length,endpointRange:range("growthRatio"),olsRange:range("impliedGrowthRatio")}));
console.log(JSON.stringify({sourceSha256:createHash("sha256").update(source).digest("hex")}));'
```

The evaluator source SHA-256 was `4f81f5f363a8fa7d77703996649fc210c97d7b2964ddde98fb634a0afa118aa7`. An earlier heredoc invocation was blocked by the read-only sandbox's temporary-file restriction; the successful command above reran the operation with escalation. No project file was written by either replay.

1. Initial status was `main` with no reported tracked edits. HEAD advanced externally during review from `0a150e23d9413389c9751bf424619f449df7b9f8` to observed `39b783fdc22219c8ae39ceec789c440ff6aedced`. `/Applications/Xcode.app/Contents/Developer/usr/bin/git diff --name-status 3929cc7 HEAD -- tests/soak/rel3-soak.mjs tests/harness/leak-tracker.mjs server web plugin.json mcp.json package.json README.md LICENSE CHANGELOG.md` returned no changes in those examined inputs at inspection.
2. The partial Attempt 3 record is `superseded`, 191.2 minutes, not an eight-hour verdict. Its available samples replay to +1.041% endpoint and +9.880% OLS over that incomplete span; those are diagnostics only and establish neither qualification nor Attempt 2's cause.
3. No final-run raw series, synchronized final sidecar, complete memory-map record, GC trace, heap snapshot, or native allocation profile was available in the requested evidence. Therefore the new run's exact arithmetic, uninterrupted quiet-host execution, live retainers and V8 allocation-limit mechanism were not independently verified.
4. No test suite, compressed soak, new eight-hour run, artifact rematerialization, profiling workload, gate amendment or release action was performed. Recorded package identities and REL-1 observations were inspected, not independently recreated.

**Each voice's own bottom line**

📋 **John:** “A now. Preserve FAIL and hold v0.2.0. An explicit prospective B can be honest; C as phase-chasing cannot. Keep candidate `3929cc7` frozen.”

📐 **Mara:** “The endpoint gate is a flawed phase-sensitive stability statistic. Choose B before another qualification, but neither my counterexample nor your supplied floor proves this run benign. An endpoint-only edit is insufficient.”

🔬 **Nikhil:** “A plus better observation first. Collect natural major-GC evidence before approving a replacement gate. We have identified no unbounded retainer and have not established a stable live set.”

🧪 **Quinn:** “Keep candidate bytes and existing REL-1; no harness-only re-cut. Preserve this failed soak. A new protocol requires an approved, validated criterion and fresh qualification—not reinterpretation of this FAIL.”

🎨 **Sally:** “Make the next run answer a defined question. Next: write the one-sentence requirement decision—stable resident footprint, or a prospective retained-state criterion—before scheduling another eight hours.”

TEAM_DONE epic-6-soak-rss-final
