HOLD — REFUSE the v0.3.0 candidate 92014de. Do not tag it, even if the serial suite finishes green.

SOAK RULING: (b). A corrected, newly frozen candidate requires a fresh qualifying 12-hour soak. A detached run on the quiet host tonight is acceptable AFTER the correctness repair and re-cut; hold the tag until the serial suite is green and that candidate-exact run qualifies with admissible host telemetry and every required gate passing. A soak of the defective 92014de cannot clear its authority bug. This confirmation grants no soak waiver. John and Sally retain their dissent below.

Review snapshot: 2026-10-29; source candidate 92014de67c1c902e97b0cb2218f825e7ef8462b3; inspected HEAD 6e746f9eb43ab6ad58d815df811de3b5f2871743. Read-only source and evidence review, using bmad-party-mode with John, Sally, Winston and Vex. Only this flat outbox is written.

📋 **John — Product Manager:** “First, credit the repairs that actually landed. APP_VERSION is now 0.3.0 (server/runtime.mjs:20). Epic 6.4 points to the replacement observation test (docs/implementation/ac-evidence.yaml:1656). Both AC sweeps pass when run now: Epic 6 has 4 stories / 8 criteria / 22 pointers; Epic 7 has 6 / 11 / 23. The inventory is 649 test declarations. Those are structural pointer checks, not successful execution of 649 tests.”

📋 **John:** “The replacement packages are real and match the new freeze. We independently traversed the existing materialization at /private/tmp/rel-v030r2, recomputed the record's digest algorithm, and compared every copied source file with the current tree. No copied-source mismatches.”

| Package | Files | Bytes | SHA-256 tree digest |
|---|---:|---:|---|
| agent-room-agent-plugin | 47 | 831824 | 9cd46f34f83fe8ddcf78bf77823155829da046ce3ea15f199f445a4556d71f6e |
| agent-room-claude-code | 47 | 831684 | 97e1ddb32c5841d4dc231cffc191f63d01444a327e6277a8db6ee3d6321c57b5 |

🏗️ **Winston — Architecture and Runtime Evidence:** “John, identity passes. The claimed safety proof does not. The new FIFO bounds generations to 4,096 entries, but eviction turns a LIVE occupancy's generation into the reusable value 0 (server/core/session-registry.mjs:177-201). A ticket can observe that 0: mint accepts nonnegative safe integers (server/api/conflict-tickets.mjs:131), and the real route passes occupancyGeneration directly (server/api/server.mjs:638-643).”

🏗️ **Winston:** “Here is the missing sequence, using the actual registry and actual ticket store, without files, SQLite or sockets:

1. Session A claims Agent. Churn 4,097 other distinct names; Agent's stamp is evicted, so its generation reads 0.
2. Mint a ticket observing the pair {A, 0}.
3. A releases Agent and reclaims it with the SAME session key. This is a NEW occupancy and receives a fresh nonzero stamp.
4. Churn 4,097 other distinct names again. The new stamp is also evicted; Agent reads 0 again.
5. Redeem the old ticket. The current pair is {A, 0}, so the server's exact pair predicate passes and registry.transfer displaces A.”

🏗️ **Winston:** “The independently repeated memory-only probe exited 0 with:

    {"probe":"zero-ABA","bound":4096,"observedGeneration":0,"reClaimedGeneration":8197,"currentGeneration":0,"apiPairCheckPasses":true,"displacedSessionKey":"holder","finalHolder":"observer"}

The real server compares only the current holder key and this generation at server/api/server.mjs:597-605, then transfers at :665-672. There is no additional occupancy discriminator. This contradicts the new refuse-only comment at session-registry.mjs:182-187, constants.mjs:556-561, and the promised A→free→A refusal. The repair trades an unbounded-retention defect for a stale-authority acceptance defect.”

🔒 **Vex — Security and Authority:** “I independently reproduced the repeated-zero pair. Be precise about the evidence: these are real modules, the exact route comparison, and an actual in-memory transfer. We did NOT execute an end-to-end HTTP takeover or measure production throughput.”

🔒 **Vex:** “Default budgets make one filler Actor slower than this frozen-clock probe: requests are per Actor at 120/minute, burst 30; tickets last 120 seconds (server/constants.mjs:22-23,552; server/api/rate-gates.mjs:108-123). That is not an invariant protecting this GLOBAL history. Multiple Actors have independent budgets, and supported request-budget overrides permit higher rates (server/api/server.mjs:1840-1843). We have not measured a network reproduction under either configuration. We HAVE disproved the unconditional claim that eviction can only refuse. This is a tag blocker in the release's central authority contract, not a claim of cross-Actor theft.”

🎨 **Sally — Operator UX:** “The added regression does not cover your sequence. It churns before the observation, then successfully replaces an unchanged holder (tests/session-replacement.test.mjs:454-464). Its later A→free→A check releases and reclaims, then immediately redeems (:469-479). It never evicts the new stamp after reclaim. The test title says ‘eviction only ever refuses’; its body does not establish that property.”

📋 **John:** “Then question 1 is NO: the repairs do not completely answer our findings. The memory bound is repaired; the occupancy-safety repair is mis-fixed. Question 3 is YES: there is a new blocker in 129f702..92014de itself. The eviction loop is the causal delta. The full diff is 11 files, confined to these repairs, documentation, metadata and the added regression; narrow scope does not make the changed behavior correct.”

🎨 **Sally:** “The coordinated upgrade guidance is materially better. Release notes :75-83 explicitly say server first, restart, verify GET /health, explain the v0.3-client/v0.2-server bare-collision misreading, and re-observe after restart. README :97-106 discloses the blind request's 400, observation/ticket flow, conflict_stale and the free-name claim/release footprint. CLI help :446-450 now says observe first. CHANGELOG :26-29 correctly separates Actor/name redemption from observing-session issuance slots. The repaired release-notes wording at :11-13 also includes recorded dispositions.”

🔒 **Vex:** “But ‘every finding repaired’ still overstates the text closure. Architecture Spine line 115 still says the ticket is bound to the observing session. Its request-half still lists wrong Actor categorically under conflict_stale, while the new response-half exception correctly gives a foreign LIVE holder's bare chat_id_taken precedence before ticket work. The runtime order is correct at server/api/server.mjs:571-590; the line now contains the exception alongside the older misleading generalizations. Correct the authority prose to Actor/name/observed occupancy and issuance-slot semantics; do not invent new session-confinement behavior.”

🎨 **Sally:** “My old release-promise finding is also only partly addressed. README :64-65 and CLI help at server/cli/agent-room.mjs:462-463 still say the name is released ‘right away’. The actual CLI receipt can report released:false and a surviving claim (server/cli/session-commands.mjs:294-303,354-357). The new README caveat is in the MCP teardown paragraph (:84-95), rather than qualifying the session-replace promise. Release notes :44-49 still open with release-before-exit, followed by the existing failure exception. These are remaining truthfulness corrections, not another newly demonstrated teardown implementation bug. Carry the failed-release condition into the command promise and free-name description.”

📋 **John:** “Now the soak disagreement. I still favor (a) for a corrected candidate that receives a new confirmation: protect the actual missing eviction→observation→release/reclaim→eviction sequence, verify the re-cut packages, obtain the green serial suite, and record a release-specific waiver explicitly superseding HANDOFF.md:222. A fixed-name traffic soak does not exercise this authority regression. The new counterexample does not show that the now-bounded map is unbounded again. I do not preapprove unknown repaired bytes.”

🏗️ **Winston:** “I agree that the soak cannot replace that regression. I disagree that this lets us waive qualification. Our first review found the unbounded retained history; this repair introduces a second lifecycle correctness defect. The repaired-state argument has again failed on actual source behavior. I retain (b), case-specific: repair correctness, re-cut, then complete the fresh qualifying twelve hours. HANDOFF.md:222 still records new RC = re-soak; the ratified formal-soak amendment fixes twelve hours at :185 and requires admissible telemetry and candidate-exact identity at :190-191.”

🎨 **Sally:** “I side with John's technical acceptance path: targeted proof plus a plainly recorded waiver would satisfy me after the code and remaining promises are corrected. That would replace the earlier soak decision, not comply with it. Winston's extra twelve-hour condition remains his; I am not changing my view to produce unanimity.”

🔒 **Vex:** “I retain Winston's veto and (b). Bounded memory alone is insufficient after this demonstrated invalidation failure. A detached quiet-host run tonight is an acceptable execution plan AFTER the final repair and freeze. Hold the tag until qualified PASS and green serial-suite evidence. Launch success is not qualification; missing or invalid telemetry, a confounded window, interruption or docs-drift identity cannot be treated as PASS. Follow the existing amendment's decision tree, not a new threshold chosen after the run.”

📋 **John:** “That makes the lane decision unambiguous despite our disagreement: no waiver is granted here. The practical release path includes the fresh qualifying soak. None of us accepts tagging the present candidate, and none accepts soaking this defective candidate as a substitute for its repair.”

Evidence execution and limits:

1. Direct Git inspection: /Library/Developer/CommandLineTools/usr/bin/git diff 129f702..92014de was read in full. The same binary's diff --exit-code 92014de HEAD -- server web README.md CHANGELOG.md LICENSE package.json plugin.json mcp.json scripts/package-release.mjs exited 0, empty. HEAD adds/updates only the two archived verdicts, freeze record and release notes; there is no packaged-input drift after 92014de. Direct status --porcelain=v1 was empty before delivery. The delta does not demonstrate an additional credential exposure; this is not a broad secret-free guarantee.
2. node scripts/ac-sweep.mjs --epic 6 and node scripts/ac-sweep.mjs --epic 7 each exited 0, clean, with the counts above. APP_VERSION and the corrected test pointer were read directly. We did not independently rerun package.test.mjs or the new HTTP regression.
3. Read-only Node traversal of /private/tmp/rel-v030r2 used tests/release-smoke.test.mjs:248-271's path/content hash fold. Both digests, byte counts and file counts match candidate.json:17-27; every copied source file matches. No package was created or modified by this review.
4. The following exact isolated command exited 0. It creates no files and fixes time only inside the two imported in-memory structures. It reproduces a correctness counterexample, not measured HTTP feasibility:

node --input-type=module -e '
import assert from "node:assert/strict";
import {createLiveSessionRegistry} from "./server/core/session-registry.mjs";
import {createConflictTicketStore} from "./server/api/conflict-tickets.mjs";
import {GENERATION_HISTORY_MAX} from "./server/constants.mjs";
const actor="sha256:"+"a".repeat(64), now=()=>1000;
const registry=createLiveSessionRegistry({now});
const tickets=createConflictTicketStore({now});
const claim=(sessionKey,chatId)=>registry.claim({sessionKey,chatId,actorFingerprint:actor});
const churn=prefix=>{for(let i=0;i<=GENERATION_HISTORY_MAX;i++){claim("churn",prefix+"-"+i);registry.release("churn");}};
claim("holder","Agent");churn("before");
const observedGeneration=registry.occupancyGeneration("Agent");
assert.equal(observedGeneration,0);
const {ticket}=tickets.mint({actorFingerprint:actor,chatId:"Agent",observerSessionKey:"observer",incumbentSessionKey:"holder",observedGeneration});
registry.release("holder");claim("holder","Agent");
const reClaimedGeneration=registry.occupancyGeneration("Agent");
churn("after");
const observed=tickets.redeem({ticket,actorFingerprint:actor,chatId:"Agent"});
const currentHolder=registry.holderOf("Agent"),currentGeneration=registry.occupancyGeneration("Agent");
const apiPairCheckPasses=currentHolder!==null&&currentHolder.sessionKey===observed.incumbentSessionKey&&currentGeneration!==null&&currentGeneration===observed.observedGeneration;
assert.equal(apiPairCheckPasses,true);
const result=registry.transfer({sessionKey:"observer",chatId:"Agent",actorFingerprint:actor,incumbentSessionKey:observed.incumbentSessionKey});
assert.equal(result.displacedSessionKey,"holder");
console.log(JSON.stringify({probe:"zero-ABA",bound:GENERATION_HISTORY_MAX,observedGeneration,reClaimedGeneration,currentGeneration,apiPairCheckPasses,displacedSessionKey:result.displacedSessionKey,finalHolder:registry.holderOf("Agent").sessionKey}));
'

5. NOT verified here: completion/exit of the required node --test --test-concurrency=1 --test-timeout=600000; a new strict-validator execution; any fresh qualifying soak; live mixed-version behavior; remote-host or real-child reruns. candidate.json:32 still records the suite running. Local suite-v030*.log fragments contain validator/version-mismatch failures without a complete candidate-bound receipt; they prove neither that the present rerun is green nor that it has failed. The strict-validator pass is recorded at candidate.json:31, not independently rerun by this review. We do not promote prior v0.2 soak evidence into v0.3 qualification.

The minimum corrective path is to preserve a never-reused generation on each live occupancy, so forgetting historical names cannot make a changed occupancy compare equal to an old ticket; add the missing before-and-after eviction regression; correct the remaining promises; re-materialize and freeze a replacement candidate. Do not restore permanent per-name history or a blind-takeover fallback. No edits or launches were performed in this review.

Each voice's own bottom line:

📋 **John — HOLD:** Repair zero-generation stale acceptance and add its regression, finish the identified authority/release wording, re-cut and verify identity, obtain the green serial suite and a new confirmation. I would then SHIP under an explicit scoped soak waiver; I do not independently require another twelve hours.

🎨 **Sally — HOLD:** Meet the correctness, accurate promises, re-cut identity and green-suite conditions. I favor SHIP with John's recorded waiver; absent a granted waiver, complete the qualifying soak. Current 92014de does not satisfy either path.

🏗️ **Winston — HOLD:** Repair and regress repeated-zero occupancy acceptance, re-cut and verify package identity, obtain green serial-suite evidence AND a fresh candidate-exact qualifying 12-hour PASS. Detached quiet-host execution with the tag held until its verdict satisfies my operational condition.

🔒 **Vex — HOLD:** Correct the stale-authority defect and remaining authority/release overclaims, re-cut and verify, obtain green serial-suite evidence AND the fresh qualifying twelve-hour PASS. No waiver. A green suite or soak on 92014de cannot rescue this candidate.

TEAM_DONE v030-confirm-codex
