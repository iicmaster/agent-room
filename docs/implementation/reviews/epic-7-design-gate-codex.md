Keep the six stories; revise their acceptance boundaries, and REFUSE the A7 mechanism as currently specified.

Task: epic-7-shape-codex. Advisory only. Reviewed HEAD 8a13348615f3d81a5b2643990fd1826f7c690038, including Epic 7 at docs/epics.md:628–698. No implementation, commit, push, service operation, or test execution was performed. This outbox is the only file written by this review.

The bmad-party-mode room: 📋 John, product manager; 🎨 Sally, UX designer; 🏗️ Winston, systems architect; 🔒 Vex, security engineer; 😤 Grumbal, adversarial verifier. The installed party, PM, and UX skill instructions informed the room. Project BMAD resolver/config files are absent; this is an explicit cast using the installed persona defaults. The requested file deliverable bounds this discussion; no party memory or keepsake is written.

**1. Epic shape — keep six stories, with specific corrections**

📋 **John:** “Winston, the split follows the actual work. A5 and A7 jointly determine whether the fence works; A8 and A9 jointly determine whether shutdown works. Splitting those pairs into separate stories would hide their dependency.”

| Story | Recorded obligation | Ruling |
|---|---|---|
| 7.1 | A5 + A7 + the two shipped-comment corrections | Keep together; ratify the corrected retention mechanism before building. |
| 7.2 | A6 observed-incumbent intent | Keep; explicitly require the promised spine/wire amendment. |
| 7.3 | A8 signal teardown + A9 first-bind shutdown race | Keep together; replace the universal teardown promise with a bounded, testable lifecycle contract. |
| 7.4 | A2 automatic-recovery decision | Keep as DESIGN or reasoned REFUSAL. It does not commit to implementing unattended recovery. |
| 7.5 | A4 freshness observer + A10 computational evidence verifier | A deliberate, legitimate addition from the open release ledger; label that provenance. |
| 7.6 | Attempt 6 retained-state finding | Required v0.3 follow-up; include calibration and an honest inconclusive outcome. |

📋 **John:** “The first three stories cover all five explicitly assigned runtime repairs. The comments are specifically assigned beside A5/A7 by the release resolution. The retained-state finding is explicitly carried to v0.3. A4 and A10 are recorded OPEN release tasks, but the retro does not assign them to v0.3 the way it assigns A5–A9. Epic 7 elects to adopt them. That is a visible scope choice, not invented debt.” Sources: docs/implementation/epic-6-retro-2026-10-21.md:254–265,277–281; docs/implementation/reviews/epic-6-release-gate-2026-10-25-resolution.md:60–68,97–104; docs/epics.md:630,686–698.

😤 **Grumbal:** “John, three acceptance gaps still matter. First, A6 expressly says ‘wire change: it needs its own spine amendment.’ Story 7.2 names the ticket but omits that deliverable. Second, ‘every teardown path’ and ‘a killed … child never leaves its name reserved’ promise something SIGKILL, host failure, and failed network delivery cannot provide. Third, the epic’s opening description should not imply that every defect was experimentally reproduced: the original review identified A9 from source and explicitly said it was not reproduced.” Sources: retro:261,263–264; docs/epics.md:630,658–666; docs/implementation/reviews/epic-6-release-gate-codex.md:64; docs/implementation/reviews/epic-6-lease-astra.md:39,61–63.

🏗️ **Winston:** “And 7.6 must not force a false binary. A finite trace may establish neither a leak nor a bound. Add calibration/coverage disposition and allow INCONCLUSIVE with the unresolved question and follow-up stated. Do not call that a bounded non-defect. A11 still names calibration as open; the ratified amendment calls the diagnostic threshold PROVISIONAL and defines inconclusive explicitly.” Sources: retro:257; docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md:187–189; docs/epics.md:698.

📋 **John:** “Those are amendments to these six stories, not a seventh feature. A3’s copy recipe, A12’s host contract, and A13’s standing instrument-validation rule do not require new session-authority stories. Apply A13 to instruments introduced by 7.5/7.6 before relying on them. Keep the current structural-verifier boundary: recording metadata can be parsed without pretending that this proves the recording’s semantic contents.”

**Ruling:** The grouping is right. Explicitly add the A6 amendment; narrow 7.3; give 7.6 a calibration/inconclusive disposition; distinguish 7.5’s adopted release work from mandatory session repairs. No missing seventh feature is established by the cited ledger.

**2. Story order — the room does not agree on a strict serial order**

🎨 **Sally:** “John, hold 7.4’s design round-table first. A supervisor, logical-session slot, or per-slot successor generation can reshape the bind and takeover vocabulary. If we freeze a new ticket contract and only then decide what a continuing session means, that is avoidable rework. The retro itself calls A2 the most likely next story.” Sources: retro:312–315; docs/epics.md:668–676.

📋 **John:** “I oppose making that a prerequisite for every repair. The same retro calls A5–A9 the next release’s first five repairs, and corrected Story 6.4 makes A5 the next release’s first acceptance criterion. We already know that an authenticated predecessor must stay fenced and shutdown must not publish a late bind. An unresolved automatic-recovery design does not erase either obligation.” Sources: retro:290–298; docs/epics.md:614,640–642.

🏗️ **Winston:** “Sally’s rework concern is real, principally for 7.2. A2 could change session identity, epochs, authentication, and bind/transfer vocabulary. It could also affect how 7.1 stores authority and how 7.3 coordinates startup. So I will not promise zero rework. But these are representation and integration risks: no defensible A2 outcome removes the invariants behind A5–A9.”

😤 **Grumbal:** “Winston, that is not a reason to let architecture delay three repairs with demonstrated user impact. My preference is to repair 7.1–7.3 after their own mechanism/wire gates, then let 7.4 refuse unattended recovery if necessary. Sally wants a product decision before the new wire freezes; I rank closure of the existing defects first.”

📋 **John:** “My dependency ruling: ratify A7 now; allow 7.1 and 7.3 to proceed; require 7.4’s bounded design-or-refusal before finalizing 7.2’s spine amendment. Story numbers need not imply a serial dependency. A2 implementation is never a prerequisite.”

🎨 **Sally:** “I still prefer actually holding the design discussion first. I accept that its permitted refusal must end the dependency; I do not accept deferring the discussion until all session interfaces are already settled.”

**Ruling:** Do not impose a global design-first build dependency. Resolve the A2 interface question before 7.2’s wire freezes, while 7.1/7.3 can move. Sally retains design-first scheduling preference; Grumbal retains strict repair-first preference. Their disagreement is the cost of early interface alignment versus delaying known repairs, not whether the safety invariants are necessary.

**3. A7 mechanism — counting is sound in principle; the draft is NOT complete**

🔒 **Vex:** “Winston, the invariant is this: while any successfully authenticated request can still resume under key K, superseding K must remain observable to that request. ‘Registered at admission’ is insufficient until admission is defined at the first exposure of the authenticated principal.”

During this review, a supplemental working-tree file was discovered: docs/implementation/spec-7-1-the-fence-never-lies.md. Its own baseline labels it a draft on 8a13348; it is not part of that commit. The following concrete objections apply to its text as read, as well as to any interpretation of the prompt that permits those choices:

🔒 **Vex:** “It explicitly increments after the stage loop (draft:50–52). That is too late. AuthStage assigns context.session synchronously, but runPipeline awaits every stage, including this synchronous stage. The SEND budget stage can already await the body before the loop finishes. The proposed count can still be zero while an authenticated request is suspended.” Sources: server/api/pipeline.mjs:263–270,356,609–619.

😤 **Grumbal:** “Here is the missed interleaving: old request authenticates → SEND waits for its body inside budgets, still uncounted → takeover supersedes the old key → churn prunes its supposedly unneeded zero-count fence → body completes → authz and the final lookup see no fence → registration happens too late. That falsifies the accounting proof. I am not claiming this proves a production SEND commit: the real send handler separately requires a live Chat-ID row and can refuse for that reason. The fence itself still failed its stated guarantee.” Source: server/api/server.mjs:922–924. This is a source-derived counterexample, not an executed probe.

🔒 **Vex:** “Ratify counting only with all five rules explicit:

1. Successful verification and acquiring the request’s pin are one non-yielding operation, before the first post-authentication await. Do not wait for budgets, authz, or the end of the loop.
2. Pin exactly once. Release exactly once through an enclosing lifecycle cleanup covering stage refusals/errors, input rejection/abort, handler rejection/throw, normal result, and awaited handler completion. The current handler-only try begins too late.
3. Socket closure is not completion while server work can still resume. Cleanup follows the actual authoritative continuation. The current streaming viewer is a different route class; do not count returning a streaming sentinel as universal proof that arbitrary work has ended.
4. Supersession revokes future authentication and preserves every positive-count fence. The old count bound may evict only unprotected, zero-count cached markers. It may never evict a protected marker.
5. Once superseded, no new successful authentication can acquire K; only already-accounted requests remain. Only under that invariant does ‘the count only falls’ become true. At zero, the fence may be dropped, immediately or through bounded zero-count caching.”

Sources: server/api/session.mjs:138–170; server/api/pipeline.mjs:609–633.

🏗️ **Winston:** “That makes retention proportional to genuinely outstanding displaced requests rather than historical takeover count. It does not establish a fixed memory bound under arbitrarily many stalled requests. Do not use ‘unexhaustible’ to claim bounded memory independently of request concurrency.”

🔒 **Vex:** “The supplemental draft adds a different backstop: 10×maxSessions and a throwing fence_overflow (draft:56–59,81). Refuse that placement too. Today bindSession completes durable persistence and memory transfer before calling supersede. A newly fallible supersede at that point can reject after ownership has already moved. Revoking first and then failing to retain the fence is also unsafe.” Sources: server/api/server.mjs:575–604; server/core/session-registry.mjs:252–277.

🏗️ **Winston:** “The smallest corrected path is to let protected entries exceed the historical cache bound. If a hard cap is required, capacity must be checked/reserved before durable write and transfer, with failure preserving the incumbent and reservations cleaned up on failed persistence. That requires the transfer seam to participate; changing only pipeline.mjs and session.mjs is insufficient for that capped design. A new public error also needs the appropriate vocabulary decision. The ledger does not require an arbitrary 10× cap.”

| Alternative | Ruling |
|---|---|
| Correctly pinned in-flight counting | Preferred; precise lifetime proof, with no eviction of protected entries. |
| Retain for at least a time limit | Correct only if a hard maximum covers every authoritative request continuation and actually prevents later resumption. Neither session TTL, body-size limits, nor a transport timeout alone establishes that. No such application-wide lifetime contract was verified. |
| Never drop superseded keys | Preserves fencing while the daemon lives, but retains all historical supersessions. Safe for revocation, unsuitable as an unexplained replacement for bounded state. |

**Ruling:** REFUSE ratification as written. Accept the counting approach after atomic early pinning, complete cleanup, and safe capacity semantics are specified. If “the old bound stays” means eviction of positive-count fences, reject it outright.

**4. A5 placement — approve the final synchronous fence; BAN is not required by A5**

🔒 **Vex:** “John, the precise placement is correct: after await readRequestFields(context) succeeds, perform the actor-session isSuperseded lookup synchronously, then directly invoke handler(context). No awaited helper or middleware may sit between that final check and invocation. Keep the earlier check for early refusal; do not rerun budgets or input parsing.” Source: server/api/pipeline.mjs:618–621.

🏗️ **Winston:** “For the CURRENT mutating handlers, that is a complete repair of the recorded input window when combined with A7. Session bind/transfer, direct-room creation, and message append perform their mutations synchronously. Another takeover in this server cannot interleave between that final check and those mutations. SEND’s early body read in budgets is re-entrant; the final check remains necessary even when the later field read is a no-op.” Sources: server/api/server.mjs:505–615,730,914; server/api/pipeline.mjs:356,537.

😤 **Grumbal:** “Do not turn that into ‘all displaced activity immediately stops.’ A long-poll that entered its handler before takeover can wake and read again. Its loop checks BAN, not supersession. A pre-handler guard does not cancel work already inside an awaited handler. That is outside the exact synchronous-mutation repair being ruled on here.” Source: server/api/server.mjs:847–874. Likewise, bodyless valid requests keep their ordinary behavior, but the extra check can now refuse a superseded bodyless request in a yield window. ‘Unchanged’ must not prohibit that correct strengthening.

🎨 **Sally:** “And the BAN check? An operator reading ‘session authority’ may think every permission is refreshed.”

🔒 **Vex:** “A5 names handoff authority, implemented by this fence. Its mandatory fix is not a second ban lookup, a second full token verification, or rerunning AuthzStage wholesale. The existing BAN contract says ‘at next request’ and separately requires rechecks during held polls. A second final BAN lookup is a policy tightening that can be chosen explicitly, but it is not required to close A5.” Sources: docs/epics.md:61,492; server/api/pipeline.mjs:392–410; docs/implementation/spec-4-5-ban-by-identity-key.md:26–32.

😤 **Grumbal:** “The ban spec’s broad ‘no banned key reaches a handler’ wording deserves a policy decision if someone wants stronger mid-input revocation. I still do not make it an A5 acceptance requirement. Also, BAN can be committed by another process; a last SELECT does not make that commit atomic with the subsequent mutation. Do not sell one extra lookup as universal instantaneous ban enforcement.”

**Ruling:** Approve fence-only revalidation at exactly the proposed point, with A7 fixed and no yield before the current synchronous mutations. BAN revalidation is optional scope expansion requiring an explicit policy decision, not missing A5 work. Flip the existing KNOWN GAP row at tests/session-replacement.test.mjs:527–596 to require unauthorized, handler not called, and unchanged ownership. The supplemental draft incorrectly describes an existing A7 bound-gap test row (draft:68–73); the current named gap row is A5. A7 needs its own focused regression in the existing relevant file.

**5. A2 direction — pre-commit to evidence requirements, not a mechanism**

🎨 **Sally:** “Vex, a restart should not require the operator to understand token plumbing. But we need four separate answers: Actor identity, process death, succession authority, and consent. The Actor key answers only the first. One Actor may have several legitimate sessions. Current isLive observes token existence/expiry, not whether an OS process died.” Sources: server/api/session.mjs:5–16,96–104; docs/implementation/reviews/epic-6-lease-astra.md:29–45,59.

🏗️ **Winston:** “These are candidates for the design table, not approved designs.”

| Candidate ownership evidence | What it could establish | Failure modes that the design must resolve |
|---|---|---|
| Trusted supervisor owns a logical-client slot, enforces one writer, and signs a fresh challenge binding successor key to expected incumbent/generation | An explicitly delegated authority selected this successor | Server cannot inspect a remote local lock; PID reuse and stale lock files prove little. Supervisor split-brain/restart, bypass launches, copied state, and the same-user trust boundary remain. |
| Per-slot asymmetric ownership key, fresh server challenge, compare-and-swap generation, rotation and fresh bearer issuance | Session-lineage authority and replay-resistant transition without reviving the predecessor bearer | A cloned key/state lets two processes race. Possession does not prove death or identify the rightful process. Rotation crashes, rollback and key theft need an arbiter or single-owner coordinator. |
| Incumbent-signed, one-shot successor delegation bound to Actor, name, occupancy, successor key and challenge | Explicit planned handoff | A dead incumbent cannot freshly delegate. Pre-issuance is prior delegation, not proof of death. Expiry, replay, cloning and generation invalidation still matter. |

🔒 **Vex:** “None alone answers all four questions. A persisted old session bearer resurrects the very authority we are supposed to end and identifies no rightful successor. Replacing it with an asymmetric key changes the proof protocol; it does not eliminate the durable credential or cloning threat. Silence, last_seen, a closed HTTP connection, same Actor, a copied PLUGIN_DATA directory, a slot label, or a claimed PID are not sufficient evidence.”

🎨 **Sally:** “I would allow the operator to delegate a narrow restart policy once to a trusted supervisor. That can make later supervised recovery unattended while preserving an explicit original decision. I do not demand a new prompt after every crash.”

🔒 **Vex:** “That changes what ‘explicit’ means. If the required property is a decision at each displacement, unattended takeover of a potentially live holder cannot satisfy it. Prior delegation is a possible NEW ratified policy, not compliance by renaming a silent takeover ‘resume.’ Ordinary reconnect and same-Actor possession must never acquire replacement intent accidentally.”

📋 **John:** “Therefore 7.4 pre-commits to none of these mechanisms. Require the evidence, trust boundary, exact server surface, replay/crash behavior, and consent model. Permit reasoned refusal, as the existing AC already does. Persistent storage, new schema, or automatic-recovery implementation would be a later scoped decision, not an implied deliverable of this design story.”

**Ruling:** Keep the design open. Decide explicitly whether narrow prior delegation is acceptable or whether per-event takeover consent is mandatory. Sally favors delegation as an avenue worth designing; Vex withholds approval until that contract and its failure model are ratified. No candidate is proven here.

**6. Prior decisions — intentional changes versus conflicts**

📋 **John:** “A6 intentionally replaces shipped ‘last explicit intent wins.’ Do not preserve that behavior through an old compatibility path. Amend the spine, the current contract, the client confirmation flow, and the test that currently requires both sequential takeovers to succeed.” Sources: docs/implementation/spec-6-4-reconnect-recovery-takeover.md:55; tests/session-replacement.test.mjs:264–287; retro:261.

🔒 **Vex:** “Acquire the conflict observation before the operator’s decision, then carry that same opaque ticket unchanged. Never fetch a fresh incumbent after confirmation or silently refresh the ticket on retry. Bind it to authenticated Actor, normalized Chat ID, and observed occupancy; it must not authenticate anyone by itself and must expose neither bearer nor digest. Compare before persistence/transfer. If A became B, reject. Define absence and A→free→A explicitly: an occupancy generation is needed if ‘stale observation’ includes release/reclaim by the same session key. The current lower-level expected-key guard only runs in its occupied-name branch.” Sources: server/core/session-registry.mjs:220–237; docs/implementation/reviews/epic-6-release-gate-codex.md:28,48; lease-astra:51–55. These details complete the recorded A6 promise; they do not justify a general ownership subsystem.

🏗️ **Winston:** “Story 6.4’s no-resume-storage/no-automatic-takeover boundary bounded that repair and deliberately deferred A2. It is not a permanent prohibition on designing v0.3 successor evidence. Implementing implicit replacement without an explicit amendment would conflict with it. Keep foreign-Actor refusal, persistence-before-transfer, session-key-scoped DELETE, and no automatic replace_existing intact unless a new decision expressly changes a boundary.” Sources: spec-6-4:36–40; lease-astra:51–61; docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:115.

😤 **Grumbal:** “For 7.3, one shared bounded shutdown operation must stop admission and late recovery, coordinate pending auth/bind, prevent late token publication, and release the resulting session when the server is reachable. Repeated close/SIGTERM/SIGINT paths should join it. On timeout or network failure, state failed/unknown release and exit under the declared deadline. Aborting a bind request does not prove the server never committed it. The existing release clears a token snapshot and attempts DELETE; it does not close authentication permanently. The current 2,000 ms release timeout is implemented through a socket idle timeout, not an independently proven total shutdown deadline.” Sources: server/client/api-client.mjs:230–234,460–470,496–505,584–637; server/constants.mjs:535; server/mcp-stdio.mjs:473–483,762–778. “That is the A8/A9 lifecycle repair, not a promise to solve SIGKILL.”

🎨 **Sally:** “Correct the two accepted comments in v0.3; that fulfills the release resolution. Candidate Immutability protects a frozen candidate’s qualification, not permanent retention of v0.2 behavior or text. Land the changed runtime explanations and packaged README/CHANGELOG with their stories before freezing the fresh candidate. Preserve historical evidence and qualify the new bytes; do not transfer v0.2’s PASS.” Sources: release resolution:60–73; docs/epics.md:630. “Likewise 7.6 remains an investigation of a reported finding. Turning its provisional retained-state classification into a new release gate would contradict the ratified decision unless prospectively amended.”

**Proof required before implementation acceptance; none claimed executed here**

😤 **Grumbal:** “The narrow existing home is tests/session-replacement.test.mjs. Extend it before adding another test file. The meaningful acceptance groups are:

1. A5/A7: delayed bodies across handoff; early SEND-body waiting and the first post-auth yield; more than 1,000 actual supersessions with pinned predecessors; multiple requests for one key; no handler invocation or mutation after a fenced continuation resumes.
2. Accounting/capacity: every refusal, input abort, thrown stage/handler and normal completion drains exactly once; disconnect cannot release a still-running continuation; any hard-cap refusal preserves incumbent ownership, credentials and durable state before transfer.
3. A6: two intents observed against A cannot both displace successive holders; stale/free/reclaimed occupancy, foreign Actor, wrong normalized name, retry/replay and failed persistence have the amended outcomes with no unintended state change.
4. A8/A9: real-child SIGTERM/SIGINT and gated shutdown during initial bind, repeated shutdown, reachable-server acknowledgement, bounded unavailable-server exit, and no late local token publication; retain the existing successful stdin-close behavior.
5. Instruments/heap: exercise the actual freshness/recording parser on valid and contradictory evidence; distinguish first sends from replays; give the heap investigation calibrated coverage and an explicit inconclusive branch. Never edit old evidence to make a verifier pass.”

The focused future command is `node --test tests/session-replacement.test.mjs`, followed by whichever existing pipeline/client/instrument tests the eventual diff actually touches. The current real-child row closes stdin only after a completed tool call (tests/session-replacement.test.mjs:838–860); it does not establish signal handling or the initial-bind race.

Verification boundary: this review read the cited documents, source, configuration and relevant test bodies. `git rev-parse HEAD` returned the full 8a13348 identity despite macOS xcrun cache-write-denial warnings. No test suite, in-memory exploit probe, package materialization, release validation, remote-host operation, signal experiment, heap profile, GitHub release inspection, or prototype successor mechanism was executed. Earlier executed findings and release results are evidence from the checked-in records, not newly reproduced results. The supplemental 7.1 draft is working-tree evidence only; no claim is made that it belongs to commit 8a13348 or has been ratified. The outbox’s flat-file type and exact final sentinel are checked separately after writing.

**Each voice’s own bottom line**

📋 **John:** “Keep six stories. Add the A6 amendment and truthful shutdown/heap outcomes. Repair known defects without waiting for an automatic-recovery subsystem; hear A2 before the new takeover wire freezes.”

🎨 **Sally:** “Hold the recovery design discussion first if possible. Explore explicitly delegated restart ownership without forcing operators into token mechanics. A2 must not become automatic same-Actor name seizure; 7.3 must not promise every crash is clean.”

🏗️ **Winston:** “Approve the A5 location for current synchronous mutations. Count from authentication to actual completion; protect every active fence, and make capacity refusal atomic with takeover. A2 may reshape representation, so freeze shared vocabulary deliberately.”

🔒 **Vex:** “REFUSE A7 as currently specified. Approve corrected early pinning and fence-only final dispatch. No post-transfer overflow, no displaced bearer resurrection, and no recovery design approval without an explicit ownership and consent model.”

😤 **Grumbal:** “I still prefer closing 7.1–7.3 before the larger A2 discussion. Prove refused mutation after churn, stale-intent refusal, and shutdown during bind. Green token-revocation tests and a polite stdin-close test do not prove those boundaries.”

TEAM_DONE epic-7-shape-codex
