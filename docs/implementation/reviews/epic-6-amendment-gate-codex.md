**Hold the next qualifying launch.** The amendment is an honest, explicit prospective restoration of FR-13’s RSS rule on the evidence inspected; it does not rescue attempt 4. The submitted implementation and pre-registration still have qualification and observation gaps. Keep the candidate frozen and the release held.

Task: epic-6-amendment-gate. Review only: no source edits, soak, packaging, qualification, or release action. The sole authored artifact is this flat outbox. This is a [bmad-party-mode](/Users/ngs/.agents/skills/bmad-party-mode/SKILL.md) round-table using the [release-evidence review procedure](/Users/ngs/.codex/memories/skills/agent-room-release-evidence-review/SKILL.md). Project BMAD resolvers/configuration are absent; the explicitly selected room is John (PM), Murat (test architecture and measurement), Winston (runtime architecture), and Sally (operator experience).

**Evidence binding.** Inspected `main` at HEAD `1d904c4210a4ec77a4c1b675b3db404f7a870622`, with clean reported tracked status. The [candidate record](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-candidate.json:6) pins `3929cc74f30f1b0b1f5b989c6e9fbb9d4fed6eba`, portable digest `3d90129b434b3b7adb9b4b6d8c05ed28b5a8fbf7b07951726c322cc438cf3999`, Claude Code digest `e481c9a46ea5e14865119503e6d327df3993b29a28b325eb9eee9421def2f47b`, 46 files each. The [packager lists](/Users/ngs/agent-skills/plugins/agent-room/scripts/package-release.mjs:45) exclude tests and docs. Git comparison found no changes to the listed packaged inputs between that candidate and HEAD. No fresh package materialization or physical REL-1 verification was performed.

The requested `docs/implementation/reviews/epic-6-soak-rss-final{,-claude}.md` files are absent. Both prior verdicts were read from their actual existing [first outbox](/Users/ngs/agent-skills/plugins/agent-room/.mailbox-out/epic-6-soak-rss-final:1) and [Claude outbox](/Users/ngs/agent-skills/plugins/agent-room/.mailbox-out/epic-6-soak-rss-final-claude:1). The archived attempt-4 JSON is now available and its evaluator arithmetic was independently replayed below.

📋 **John:** “Murat, my answer to Q1 is that this is a defensible requirements correction. [FR-13](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:239) specifies one least-squares band. The [ruling](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md:40) explicitly resolves the former endpoint conjunction, and the [old spec](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/spec-6-2-rel-3-the-formal-soak.md:26) is preserved under a supersession notice. That addresses our earlier objection to a silent evaluator fix. Frontmatter and commit `89223538c4b6b1193123afaab4aa2790c6e4e2c4` record owner ratification; I did not authenticate an independent approval transcript. Nothing inspected warrants alleging private intent to fit attempt 4.”

🧪 **Murat:** “John, the strongest support is behavioral: the calibration imports the real evaluator, the stationary control passes all 25 phases, the 1%/hour control fails, and attempt 4 still fails at **3.988027%**. Those are useful controls. But ‘calibrated around the bound’ overstates [the two growth controls](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak-calibration.test.mjs:106): 0.2%/hour and 1%/hour are comfortably away from the nominal 0.5%/hour boundary. Only the stationary control receives the phase sweep. My additional probes expose the missing cases:

| Control through the actual evaluator | Observed result |
|---|---|
| 100 MiB for 235 samples, then 110 MiB for the final five of 240 one-minute samples | PASS; endpoint +10%, OLS implied +1.218880% |
| Same stationary sawtooth plus 0.55%/hour injected growth, all 25 phases | 8 PASS / 17 FAIL |
| That growth control at phase 14 | Injected increase +2.104884% of initial RSS; observed OLS +1.991079%, PASS |

“The first control models a retained step that persists through the observed tail, rather than the suite’s single-sample spike. These are synthetic counterexamples, not production leak diagnoses. The rule follows its declared OLS predicate correctly, but it can pass real retained growth and remains phase-sensitive near the boundary. Missing controls: persistent late growth, near-bound growth across phases, and insufficient temporal coverage. Pin their expected outcomes and limitations before qualification.”

📋 **John:** “I accept the counterexamples. I reject using them to sneak the endpoint gate back in. A finite OLS noise band is the chosen product criterion; it is not a universal leak detector. Change [the amendment’s ‘next run able to say’ leak-free claim](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md:80) to the claim actually supported: the run met the registered RSS band and other gates. I would accept these exact counterexamples pinned in the review. Murat requires additional suite rows before launch. We disagree about that procedural requirement, not about the observations or the Boolean gate.”

🏗️ **Winston:** “Sally, Q2 has a sound observation choice and an inadequate sufficiency contract. Used heap after natural major collections is useful for examining reachable V8 heap. It does not distinguish all server retention from uncollected garbage: native/external allocations and resident allocator pages lie beyond it. A flat used heap does not explain a rising RSS. [the harness’s causal claim](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1057) needs that limit; [the official memory documentation](https://nodejs.org/docs/latest-v24.x/api/process.html#processmemoryusage) distinguishes V8 heap, external allocations and RSS, and documents fragmentation-related RSS growth.”

🎨 **Sally:** “Then the word ‘coverage’ must mean more than counting four events. [The evaluator](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1091) accepts four equal heap observations at 0, 1, 2 and 3 milliseconds inside a four-hour window as `reported`, with zero growth. It checks neither span nor comparable workload states. It computes first/last change, not a fitted trend, and the result omits event times and intermediate values. Even 40 → 80 → 90 → 40 MiB reports zero endpoint change. Four is a defensible minimum count for reporting four observations; it is not a demonstrated minimum for a four-hour trend. Pre-register temporal coverage and workload comparability, retain the observations, and call inadequate coverage **INCONCLUSIVE**. That should never become a diagnostic PASS.”

🏗️ **Winston:** “Agreed on the label, but the collector itself needs repair before the promised experiment:

1. **Completion:** [readGcTrace](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1071) calls `.end()` and immediately reads synchronously. It does not await writer completion, while the live child’s [stdout listener](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:565) can continue writing. No writer error handler or backpressure handling exists. Stream completion is asynchronous; [Node documents `finish`](https://nodejs.org/api/stream.html#event-finish) as the completion boundary. This is a source-level race/error path; actual soak trace loss was not reproduced.
2. **Parsing:** [the regex](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1084) drops major events with `(reduce)` between the collector name and heap size. The real parser accepts the plain probe and rejects its `(reduce)` counterpart. [Node’s trace guide](https://nodejs.org/learn/diagnostics/memory/using-gc-traces) documents such major-collection variants. Selective omission can distort the observed endpoints even when four other events remain.
3. **Custody:** the trace lives in the [temporary world](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:535). Default [cleanup deletes it](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1664); results keep the summary, not the full event stream. Pin `--keep` plus archival custody, or a persistent trace destination, before launch. A file written during execution and deleted afterward is not durable review evidence.”

📋 **John:** “Fix the collector because this run promises that observation. Do not make the occurrence of four natural collections a second memory pass rule. A correctly collected but legitimately thin trace may remain INCONCLUSIVE while the RSS gate independently passes or fails.”

🎨 **Sally:** “And the [60-second final settle](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1583) is present. The tracker stops before the drain, so that idle sample is outside the RSS window. It is a standardized one-minute idle reading; elapsed time does not prove a collection or equilibrium. That is enough for a reported counter-metric if its label stays precise.”

🎨 **Sally:** “Q3: here is the unmistakably missing shape in [the decision tree](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md:97): **RSS passes, retained heap is flat, but message loss, FD stability, artifact integrity or loop execution fails.** There is no disposition for it. Falling heap, unusable/null or contradictory trend summaries, interruption, and repeated INCONCLUSIVE observations also need defined dispositions. ‘Flat’ and ‘rising’ have no registered tolerance or trend classification. Repeating an observation has no stopping condition.”

📋 **John:** “Strictly, PASS plus rising heap or INCONCLUSIVE is already covered by the unconditional PASS branch. It is not a logical omission. Its operator meaning must be explicit: technical gate PASS, diagnostic finding or uncertainty preserved, and no leak-free claim. If the owner wants a separate release hold on contradictory diagnostic evidence, register that release disposition explicitly rather than changing the RSS predicate. Also ‘RSS FAIL plus flat V8 heap refutes the premise’ is an unsupported causal conclusion. Preserve the FAIL; investigate native memory, allocator residency and possible continued equilibration as well as heap state.”

🧪 **Murat:** “Q4 has two concrete existing-requirement blockers. First, [deriveSchedule](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:298) leaves the FD baseline at duration/8: **90 minutes for the registered 12 hours**. Yet the amendment says FD stability after hour one is unchanged. In my probe, FDs step from 20 to 30 at minute 70: the actual 90-minute baseline reports PASS; the hour-one baseline correctly reports FAIL. Bound the schedule to hour one while preserving compressed behavior. This is not a proposed new requirement.”

📋 **John:** “Second, interruption need not prevent a successful verdict. [The signal handler](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1358) only sets `abortRequested`; [sleepUntil](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1937) and traffic loops return, allowing normal drain. [The final PASS predicate](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1613) checks neither interruption nor completed duration. `aborted` is selected only on the catch path. With successful cleanup and a suitably timed parent-only signal, a shortened run can reach PASS. This is source-path proof, not a live reproduction; arbitrary signal timing can instead fail the loop-settle timeout, and group signaling can kill children. Enforce completion and interruption disposition before qualification.”

🧪 **Murat:** “The RSS evaluator also accepts three flat readings spanning two minutes as PASS inside a nominal four-hour window. Pre-register a minimum span/cadence or maximum-gap validity policy; sparse data must not establish four-hour compliance. Keep this separate from the fixed 2% acceptance band. Finally align existing verification: [compressed validation still asserts the demoted endpoint bound](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.test.mjs:81). The harness header and [serialized rule text](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1028) still describe the old conjunction. Seven green pure tests do not validate the amended capture lifecycle or resolve those contradictory contracts.”

🎨 **Sally:** “My finite launch checklist is:

1. Restore hour-one FD timing; prevent interrupted/incomplete or insufficiently sampled execution from qualifying.
2. Make GC capture complete, parseable, safely finalized and preserved; register temporal coverage and comparable-state interpretation.
3. Ratify dispositions for every non-RSS failure, invalid run and diagnostic outcome, including the repetition limit and accurate PASS claim.
4. Align the existing compressed test and result text with slope-only acceptance; record the missing calibration limits. John accepts pinned counterexamples; Murat requires additional controls in the suite.
5. Pin the final amendment/harness/calibration hashes, exact 12-hour launch options, Node/V8/SQLite versions and fresh evidence location before starting; verify candidate-exact package digests at launch.

“These are review preconditions, not changes made here. Nothing in this review establishes that the fixed 8–12-hour window is actually past equilibration; it places measurement later in a longer capped-load hold. The next observations must answer that empirical question without changing the statistic afterward.”

**Executed checks and limits.**

`node --test tests/soak/rel3-soak-calibration.test.mjs` → exit 0, **7 passed / 0 failed**. Node `v24.18.1`, V8 `13.6.233.17-node.50`, SQLite `3.53.4`. Archived replay through the real exported evaluator gave:

| Archive | Original status | Amended replay | OLS implied growth |
|---|---|---|---|
| Attempt 1 | PASS | PASS | −12.592553% |
| Attempt 2 | FAIL | FAIL | +213.808709% |
| Attempt 4 | FAIL | FAIL | +3.988027% |

The independent runtime reviewer also ran a bounded, no-file natural-GC canary on this Node/V8: exit 0, 13 GC lines, two plain Mark-Compact events recognized by the actual parser. That checks basic host trace format, not disk capture or twelve-hour behavior. No full test suite or compressed validation was run; compressed validation starts a five-minute workload. No future host quietness, instrumentation effect, production retainer, complete raw ack readback, physical REL-1 behavior or author motive was established.

Read-only candidate comparison command (empty diff, exit 0):

```sh
/Applications/Xcode.app/Contents/Developer/usr/bin/git diff --name-status 3929cc7 HEAD -- server web plugin.json mcp.json package.json README.md LICENSE CHANGELOG.md
```

The following exact no-file command produced the numerical counterexamples and archived replay above. It imports the real exported rules and extracts the actual FD evaluator; it launches no soak:

```sh
node --input-type=module -e 'import { readFileSync } from '\''node:fs'\'';
import { evaluateFinalWindowRss as rss, evaluateRetainedState as heap, parseMajorGcUsedHeapMiB as parse, deriveSchedule, FOUR_HOURS_MS as W } from '\''./tests/soak/rel3-soak.mjs'\'';
const MiB=2**20, minute=60000, schedule={finalWindowMs:W};
const trace=Array.from({length:240},(_,i)=>({atMs:i*minute,rssBytes:100*MiB}));
const late=trace.map((s,i)=>({...s,rssBytes:(i>=235?110:100)*MiB}));
console.log(JSON.stringify({probe:'\''permanent late step'\'',...rss(late,schedule,true)}));
const phases=Array.from({length:25},(_,phase)=>{
 const t=trace.map((s,i)=>({...s,rssBytes:Math.round((100+7*((i+phase)%25)/24+100*0.0055*i/60)*MiB)}));
 const r=rss(t,schedule,true);
 return {phase,pass:r.pass,impliedGrowthRatio:r.impliedGrowthRatio,injectedGrowthRatio:(100*0.0055*239/60)*MiB/t[0].rssBytes};
});
console.log(JSON.stringify({probe:'\''near-bound 0.55 percent/hour'\'',passed:phases.filter(p=>p.pass).length,failed:phases.filter(p=>!p.pass).length,phase14:phases[14]}));
console.log(JSON.stringify({probe:'\''RSS sparse coverage'\'',...rss(trace.slice(0,3),schedule,true)}));
console.log(JSON.stringify({probe:'\''GC clustered coverage'\'',...heap([0,1,2,3].map(childAtMs=>({childAtMs,usedHeapMiB:40})),schedule,trace,0)}));
const line='\''[1234:0x7f9c2a1b3d40] 1104 ms: Mark-Compact 12.4 (14.0) -> 9.6 (13.2) MB, 3.1 / 0.0 ms'\'';
console.log(JSON.stringify({probe:'\''GC parser variants'\'',plain:parse(line).length,reduce:parse(line.replace('\''Mark-Compact '\'','\''Mark-Compact (reduce) '\'')).length}));
for(const file of ['\''docs/release-evidence/v0.2.0-soak-results.json'\'','\''docs/release-evidence/v0.2.0-soak-attempts/attempt2-89c8477.json'\'','\''docs/release-evidence/v0.2.0-soak-attempts/attempt4-3929cc7.json'\'']){
 const d=JSON.parse(readFileSync(file,'\''utf8'\''));const r=rss(d.samples.data,d.schedule,true);
 console.log(JSON.stringify({probe:'\''archived replay'\'',file,stored:d.status,pass:r.pass,growthRatio:r.growthRatio,impliedGrowthRatio:r.impliedGrowthRatio}));
}
const actualSchedule=deriveSchedule(12*3600000);
const source=readFileSync('\''tests/soak/rel3-soak.mjs'\'','\''utf8'\'');
const body=source.slice(source.indexOf('\''function evaluateFdStability('\''),source.indexOf('\''// --- Results assembly'\''));
const fd=new Function('\''FD_DRIFT_TOLERANCE'\'',body+'\'';return evaluateFdStability'\'')(5);
const descriptors=Array.from({length:721},(_,i)=>({atMs:i*minute,fdCount:i<70?20:30}));
console.log(JSON.stringify({probe:'\''FD increase at minute 70'\'',fdBaselineMinutes:actualSchedule.fdBaselineAfterMs/minute,actual:fd(descriptors,actualSchedule,0,true),hourOne:fd(descriptors,{...actualSchedule,fdBaselineAfterMs:60*minute},0,true)}));
'
```

Reviewed source SHA-256 values, which must change if the identified repairs are made:

| File | SHA-256 |
|---|---|
| `tests/soak/rel3-soak.mjs` | `d4431b6dd82521ccb59a2512d86499e39bc6b65a2d54b47b40f73479bb69b8fe` |
| `tests/soak/rel3-soak-calibration.test.mjs` | `c586f3a9c21c13518a94f379ee30e7be4fc490257db4650872ea911412d592b9` |
| `tests/harness/leak-tracker.mjs` | `1fdaab86b10660668bfcebeacd8deedd768575d7f11a04d1c4e0b415a5ebd36a` |
| `docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md` | `886927010d6ca0dfacb76a1c19d1e1fa11fdd3e2b68cda15d11a023a3fabe9b6` |

**Each voice’s own bottom line — the calibration dispute remains unresolved.**

📋 **John:** “Accept the prospective single-band ruling. Hold launch for FD/completion integrity, promised observation reliability and complete dispositions. After those finite repairs, the same next 12-hour run may qualify; I do not require a separate diagnostic night or additional synthetic rows if these exact limits are pinned.”

🧪 **Murat:** “Honest correction, incomplete calibration. I require persistent-step, near-bound phase and coverage controls registered before qualification, as well as the concrete harness repairs. A band PASS cannot certify leak freedom. John’s acceptance of review-only calibration evidence is too weak for this pre-registration.”

🏗️ **Winston:** “Keep RSS as the gate. Refuse this qualifying launch until GC capture, parser and evidence custody are trustworthy. Four events alone cannot establish a comparable four-hour retained-state trend; legitimately inadequate natural coverage stays INCONCLUSIVE.”

🎨 **Sally:** “The current tree can still return an unexplained result or another unbounded repeat. Define invalid-run handling, every failure disposition, diagnostic labels and the repetition limit before spending the twelve hours. First concrete repair: restore the FD baseline to hour one.”

TEAM_DONE epic-6-amendment-gate
