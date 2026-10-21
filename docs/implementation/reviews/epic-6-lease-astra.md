Hold v0.2.0 release acceptance for the reconnect defect; preserve and finish the real demo evidence where possible.

Task: astra-lease. Advisory only. This is the facilitator's recommendation, not a unanimous panel verdict or a release action.

Read-only scope: determine A (v0.2 scope), B (smallest correct repair), and C (honest demonstration if deferred). Only this outbox is written. No product edits, test-file edits, soak, server restart, deployment, or release action.

BMAD cast: 📋 John — product manager; 🎨 Sally — UX designer; 🏗️ Winston — systems architect; 🔒 Vex — session/security reviewer; 😤 Grumbal — release skeptic. The installed bmad-party-mode, PM, and UX skill instructions informed the cast. Project BMAD resolver/config files are absent, so this is an explicit cast, not a claimed saved-roster resolution. An independent gpt-6-astra advisory agent reviewed the session design; a separate reviewer examined release requirements. No dedicated codex-advisor connector was available.

**A — Product scope and the release gate**

📋 **John:** “Grumbal, preserve the milestone we actually observed. REL-1 requires physical machines, Claude Code and Zcode, DM plus Broadcast exchange, and the authenticated viewer with presence, freshness within five seconds, DM exclusion, transcript, recording and browser evidence. It does not explicitly require a client restart. I would complete the stable-session demonstration while those real hosts are available. Do not retroactively make every good observation false because we discovered a second journey fails.” [docs/epics.md:578](/Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:578)

😤 **Grumbal:** “John, credit that evidence. I still block ordinary v0.2 release readiness. FR-12 explicitly includes clients that died, slept or lost connectivity; continuity and reconnection are in MVP scope. Closing a terminal and being unable to return under the same chosen name is an ordinary product failure. Protecting eight hours already invested is not a scope argument.” [docs/prds/prd-agent-room-2026-09-20/prd.md:214](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:214) [docs/prds/prd-agent-room-2026-09-20/prd.md:228](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:228) [docs/prds/prd-agent-room-2026-09-20/prd.md:341](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:341)

📋 **John:** “I disagree with treating the release conclusion as mechanically dictated by one sentence. FR-12 says re-claim OR re-pick, and states no universal two-second crash-recovery deadline. A release owner could explicitly accept a known reconnect limitation. I would consider that deferral to preserve the present demo window. It would be an explicit product-risk decision, not a claim that this is merely a harness defect.”

🎨 **Sally:** “John, that wording does not make the experience acceptable. The operator sees nobody online under their name and gets ‘taken’ after restarting their own client. The data structures distinguish recency from ownership, but the interface gives the operator no recovery action. Keep the successful conversation evidence; do not describe the client lifecycle as ready. Also, one precision: changing Chat ID does not rotate the installation's key or Actor identity. It does change addressing and visible attribution, which is enough to invalidate the continuity demonstration the user wants.” [docs/prds/prd-agent-room-2026-09-20/prd.md:122](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:122)

😤 **Grumbal:** “And the harness explanation cannot rescue this. Its reconnect cycle closes the children, then issues SESSIONS_MAX + 2×CLIENT_COUNT throwaway local tokens before rebinding. That deliberately makes the previous tokens invalid. It proves recovery after forced token eviction, not a normal remote process restart. Changing tests/soak/rel3-soak.mjs leaves packaged bytes unchanged because tests/ is excluded, but cannot free a stranded production session. Nor can a changed harness retroactively expand what the old PASS proved.” [tests/soak/rel3-soak.mjs:1669](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1669) [tests/soak/rel3-soak.mjs:1710](/Users/ngs/agent-skills/plugins/agent-room/tests/soak/rel3-soak.mjs:1710) [scripts/package-release.mjs:45](/Users/ngs/agent-skills/plugins/agent-room/scripts/package-release.mjs:45)

**A answer:** Yes, this belongs to v0.2 product continuity scope. The facilitator recommends fixing it before release. John preserves a dissenting case for an explicit limitation/deferral and for crediting the bounded REL-1 demo. The literal REL-1 script and overall product readiness are different judgments. A shipped fix voids candidate 89c8477's qualification for the changed bytes: recut, rerun Story 6.3 gates, and complete a fresh eight-hour REL-3 plus candidate-bound REL-1 evidence. A harness-only change does not require a package recut, but it does not fix this defect. [docs/release-evidence/v0.2.0-candidate.json:6](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-candidate.json:6)

**B — What actually holds the name, and the smallest correct fix**

🏗️ **Winston:** “Sally, the failure is confirmed in source and in a narrow executed probe. The fresh client stores no predecessor bearer: sessionToken starts null in process memory. It authenticates again, then POSTs the configured Chat ID. The server permits same-Actor recovery only if isLive(oldSessionKey) is false. That function checks token existence and expiry; it does not observe a process. Auth expiry slides by twelve hours on verification. The name lease also defaults to twelve hours, while presence filtering hides a silent row after 180 seconds without deleting it.” [server/client/api-client.mjs:404](/Users/ngs/agent-skills/plugins/agent-room/server/client/api-client.mjs:404) [server/client/api-client.mjs:454](/Users/ngs/agent-skills/plugins/agent-room/server/client/api-client.mjs:454) [server/api/server.mjs:508](/Users/ngs/agent-skills/plugins/agent-room/server/api/server.mjs:508) [server/api/session.mjs:91](/Users/ngs/agent-skills/plugins/agent-room/server/api/session.mjs:91) [server/api/session.mjs:123](/Users/ngs/agent-skills/plugins/agent-room/server/api/session.mjs:123) [server/core/session-registry.mjs:143](/Users/ngs/agent-skills/plugins/agent-room/server/core/session-registry.mjs:143) [server/core/session-registry.mjs:358](/Users/ngs/agent-skills/plugins/agent-room/server/core/session-registry.mjs:358)

🔒 **Vex:** “Winston, say ‘up to about twelve hours after the last relevant activity, absent earlier release or eviction,’ not ‘twelve hours measured from process exit.’ DELETE /api/session already exists and releases only the authenticated session key. It intentionally keeps the durable claim and does not revoke the bearer. The MCP close path aborts calls but never sends that DELETE. A newly authenticated session cannot DELETE the old holder merely because it has the same fingerprint.” [server/api/server.mjs:548](/Users/ngs/agent-skills/plugins/agent-room/server/api/server.mjs:548) [server/mcp-stdio.mjs:742](/Users/ngs/agent-skills/plugins/agent-room/server/mcp-stdio.mjs:742)

🎨 **Sally:** “Then make the same installation's bind idempotent across tokens. The operator should restart and continue, not learn token internals.”

🔒 **Vex:** “That is a transfer, Sally, not idempotency. The same key may operate multiple legitimate sessions. A replacement and a competing process both present the same Actor, a new token and the same name. Current code explicitly refuses even same-Actor live collisions. Unconditional replacement changes that contract; simply revoking the old token is insufficient because its client automatically reauthenticates and can take the name back.” [server/core/session-registry.mjs:208](/Users/ngs/agent-skills/plugins/agent-room/server/core/session-registry.mjs:208) [tests/session-routes.test.mjs:171](/Users/ngs/agent-skills/plugins/agent-room/tests/session-routes.test.mjs:171) [server/client/api-client.mjs:748](/Users/ngs/agent-skills/plugins/agent-room/server/client/api-client.mjs:748)

🏗️ **Winston:** “I reject a remote PID check as well. This server cannot distinguish a dead process from sleep, a partition or a quiet client through the current HTTP protocol. A closed HTTP connection is not the end of the MCP session. A timeout is an ownership policy, not proof of death.

“Here is the comparison we need:

| Candidate | What it solves | Remaining issue |
|---|---|---|
| Bounded DELETE on MCP shutdown | Orderly exit when the request reaches the server | SIGKILL, host failure and a lost shutdown request still strand the name. Stop admission and late authentication before disconnect; never bootstrap a new session to close the old one. |
| Shorter independent name lease | Bounds abandonment | Needs renewal and expiry/rebind behavior; global expiry allows another Actor to claim the name. Tuning presence TTL alone changes no lease. |
| Same-Actor reclaim after 180 s | Bounds same-owner recovery without globally freeing names | Can displace an idle-but-living session; needs visible wait/retry. Current 409 handling does not automatically wait out a lease. |
| Unconditional same-Actor bind replacement | Immediate recovery after kill | Silently displaces legitimate holders and permits reauthentication ownership loops unless the contract changes. |
| Explicit same-Actor replacement | Immediate, deliberate operator-assisted recovery under the same name | Requires a small but real ownership-transfer contract and client recovery action; it is not automatic crash resumption. |

“The 180-second policy particularly needs care: agent-generation gaps are explicitly permitted, and the inspected client contains no periodic heartbeat loop consuming the heartbeat constants. Turning current presence absence into death would break idle clients.” [server/client/api-client.mjs:695](/Users/ngs/agent-skills/plugins/agent-room/server/client/api-client.mjs:695) [tests/presence.test.mjs:437](/Users/ngs/agent-skills/plugins/agent-room/tests/presence.test.mjs:437) [tests/presence.test.mjs:492](/Users/ngs/agent-skills/plugins/agent-room/tests/presence.test.mjs:492) [docs/prds/prd-agent-room-2026-09-20/prd.md:236](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:236)

🔒 **Vex:** “My smallest complete recommendation for immediate **operator-assisted** recovery is explicit same-Actor replacement through the existing session-bind surface. Ordinary startup, PATCH rename and automatic reauthentication keep their collision protection. The user deliberately chooses to replace this installation's named session after a conflict. This needs no new service, no replacement of durable Chat-ID claims, and no persistent resume-token system merely to support that action.

“The required guarantees are:

1. Authenticate the Actor from server-derived credentials; require the same Actor and bind replacement intent to the observed incumbent. Reject foreign-Actor claims and stale replacement intent. Never expose the incumbent's bearer or token digest as a public takeover credential.
2. Validate and perform the durable claim write before atomically changing memory ownership and revoking the incumbent. Persistence failure must leave the incumbent intact.
3. Recheck authority immediately before mutations that could have been admitted before handoff. Authentication is followed by awaited stages and body reading, so admission alone is not sufficient fencing.
4. Keep DELETE session-key-scoped. A delayed predecessor DELETE must not release the successor; ordinary automatic reauthentication must never carry replacement intent.
5. Preserve other Chat IDs belonging to the same Actor, the other machine's session, durable claims, room membership, history and cursors.

“The exact conflict/transfer ticket and client command are design work, not existing functionality. This is a documented API-behavior amendment. Do not label it a harmless two-line patch.” [server/api/server.mjs:523](/Users/ngs/agent-skills/plugins/agent-room/server/api/server.mjs:523) [server/api/pipeline.mjs:583](/Users/ngs/agent-skills/plugins/agent-room/server/api/pipeline.mjs:583) [server/api/session.mjs:118](/Users/ngs/agent-skills/plugins/agent-room/server/api/session.mjs:118)

🎨 **Sally:** “Vex, that is an acceptable emergency recovery button. I still want automatic restart recovery as the normal experience. If ‘smallest’ means the person must authorize replacement after every crash, say that plainly. Seamless recovery while also protecting a concurrently active session needs session-specific resume/ownership evidence. The Actor key alone cannot answer which process is the successor.”

🏗️ **Winston:** “Agreed about the distinction, not about making a full resume system mandatory for this repair. Start with explicit replacement if operator-assisted recovery is the accepted requirement. Do not add persistent resume storage until automatic recovery is selected. Graceful shutdown DELETE is useful cleanup, but it cannot be presented as the complete kill/restart fix.”

**B answer:** The smallest complete, defensible option identified here is **explicit same-Actor handoff for operator-assisted recovery**, with atomic transfer and fencing. Automatic transparent recovery remains a separate unresolved requirement; it needs a session-resume/ownership design. Graceful DELETE alone is partial. Neither global lease shortening nor implicit 180-second takeover is a safe drop-in correction.

Expected implementation scope, if subsequently authorized: session route schema/handler and live registry; API-client plus the chosen existing human control surface; mutation dispatch revalidation only where needed for the handoff guarantee. Extend the existing session/claims and remote-client tests. No new dependency or database schema is intrinsically required for explicit replacement. A shutdown hook would additionally touch mcp-stdio.mjs and must be justified separately.

Required proof would use the same unchanged remote server while terminating and replacing only one client, keeping the other client online. Cover graceful exit and SIGKILL; same Actor/same name recovery; same Actor/different-name coexistence; foreign-Actor refusal; persistence failure; two competing replacements; delayed old POST/PATCH/send/DELETE; absence of ownership ping-pong; and continued room/cursor/DM operation. No server reset or token flooding in the acceptance path. These are proposed checks, not executed results.

**C — If the release owner defers the defect**

📋 **John:** “Grumbal, here is the honest version of my position. Preserve today's real run and finish the remaining REL-1 observations if both clients are already live. Record it as a stable-session cross-machine demonstration on the exact candidate, with client restart/reclaim separately marked failed or blocked. Do not relabel the observed successful enrollment, bidirectional DM, trust handling and DM-safe viewer as unproven simply because this advisory did not witness them.”

😤 **Grumbal:** “And keep the operator interventions in the record. Each restart/reset needs its timestamp, reason and affected sessions. If a name is already stranded and the old token is gone, current shipped behavior has no supported fresh-login action that releases that particular incumbent. Waiting for expiry or a disclosed administrative restart can enable a new segment; neither proves client reconnect works. Changing names or minting a thousand tokens is not continuity proof.”

🎨 **Sally:** “A prepared continuous-session demo can be honest if its setup and limits are explicit. Preserve the names and fingerprints in the evidence. Capture the required Broadcast exchange, ≤5 s viewer freshness, transcript, recording and browser session wherever they remain outstanding. If the required evidence cannot be completed, record the partial result rather than inventing a pass.”

**C recording sequence, advice only:**

1. Preserve the successful segment and the exact candidate/package identity, topology, names and fingerprints.
2. Record the restart failure and every recovery intervention as separate events; retain the original logs and captures.
3. Complete outstanding REL-1 observations in a continuous session if available; do not claim unassisted reconnect.
4. Mark any release deferral explicitly with the defect, user impact and decision owner. A clean REL-1 segment does not cancel the known product defect.
5. When product bytes change, use the old demo as historical evidence and qualify the replacement candidate; do not transfer the old candidate's PASS.

**Evidence and verification boundaries**

Source snapshot: HEAD c2cafeb20d82b658bc4f38b01d4b5655b8799eb3; candidate record names 89c847787357be9e0ede135337eee4a1a29f48bf. The independent Astra reviewer found no candidate-to-HEAD diff in the inspected runtime/tests. Seven relevant runtime files also match both local package copies. However, those complete local package trees do not match the current candidate record's full digests; they are not proof of exact deployment/package identity.

The user's current Zcode-Mac / Claude-staging / :18444 observations are accepted as supplied real-demo evidence, not reclassified as a test artifact. This advisory did not independently connect to ngs-2 or ngs-staging, inspect the live server registry, repeat the physical demo, inspect current CA/TLS runtime configuration, or verify the current soak process. The checked-in older cross-machine report describes a different run; it cannot verify or contradict today's captures.

The checked-in soak PASS is associated with 7dc980f. The state record describes candidate 89c8477 attempt 2 as failed and attempt 3 as running. That is document state, not a live-status determination. No claim is made here that 89c8477 currently has a qualifying eight-hour PASS. [docs/release-evidence/v0.2.0-soak-results.md:3](/Users/ngs/agent-skills/plugins/agent-room/docs/release-evidence/v0.2.0-soak-results.md:3) [docs/implementation/epic-6-state-in-progress.md:23](/Users/ngs/agent-skills/plugins/agent-room/docs/implementation/epic-6-state-in-progress.md:23)

Executed verification: a read-only in-memory probe imported the actual auth and live-registry modules with an injected clock. It returned exit 0 and four PASS checks: refusal after 8 seconds; offline-but-auth-live/name-held/refused at 180001 ms; expiry/rebind at 43200001 ms; and immediate rebind after explicit release. This proves the registry mechanism; it is not an HTTP, real process-exit or release-qualification test. The first heredoc invocation was blocked by the read-only shell sandbox before Node ran; the same probe succeeded via an approved node -e invocation without files or network.

Exact executed command was `node --input-type=module -e` with the following single argument:

```javascript
import assert from 'node:assert/strict';
import { createSessionRegistry, sessionKeyFromToken } from './server/api/session.mjs';
import { createLiveSessionRegistry } from './server/core/session-registry.mjs';
import { PRESENCE_TTL_MS, SESSION_TTL_MS } from './server/constants.mjs';
let clock = 1000000;
const actor = 'sha256:' + 'a'.repeat(64);
const auth = createSessionRegistry({ now: () => clock });
const live = createLiveSessionRegistry({ now: () => clock });
const oldKey = sessionKeyFromToken(auth.issue(actor));
live.claim({ sessionKey:oldKey, chatId:'ZCODE-MAC-1', actorFingerprint:actor });
clock += 8000;
let newKey = sessionKeyFromToken(auth.issue(actor));
assert.throws(() => live.claim({ sessionKey:newKey, chatId:'ZCODE-MAC-1', actorFingerprint:actor }), {code:'chat_id_taken'});
console.log('PASS 8 seconds: same-Actor fresh token cannot bind held Chat ID');
clock = 1000000 + PRESENCE_TTL_MS + 1;
assert.equal(live.presenceSnapshot().online.length, 0);
assert.equal(auth.isLive(oldKey), true);
assert.equal(live.holderOf('ZCODE-MAC-1').sessionKey, oldKey);
assert.throws(() => live.claim({ sessionKey:newKey, chatId:'ZCODE-MAC-1', actorFingerprint:actor }), {code:'chat_id_taken'});
console.log('PASS 180001 ms: offline view, old auth live, name held, rebind refused');
clock = 1000000 + SESSION_TTL_MS + 1;
assert.equal(auth.isLive(oldKey), false);
newKey = sessionKeyFromToken(auth.issue(actor));
assert.equal(live.claim({ sessionKey:newKey, chatId:'ZCODE-MAC-1', actorFingerprint:actor }).chatId, 'ZCODE-MAC-1');
console.log('PASS 43200001 ms: expiry and claim sweep allow same-name rebind');
const nextKey = sessionKeyFromToken(auth.issue(actor));
assert.equal(live.release(newKey), true);
assert.equal(live.claim({ sessionKey:nextKey, chatId:'ZCODE-MAC-1', actorFingerprint:actor }).chatId, 'ZCODE-MAC-1');
console.log('PASS explicit release permits immediate rebind');
console.log('PROBE: real registry modules; injected clock; no HTTP, child-process kill, filesystem writes, or soak');
```

No existing test suite, focused HTTP test, soak, package validator, REL-1 verifier or physical runtime check was executed. Product files were not edited.

**The disagreement remains:** John will consider an explicitly accepted release limitation and wants the present stable-session milestone credited. Sally and Grumbal oppose shipping this everyday reconnect failure. Winston and Vex support the smaller explicit replacement path; Sally wants seamless automatic recovery. They differ over acceptable user intervention and release risk, not over whether the observed lease mechanism exists.

**Each voice's own bottom line**

📋 **John:** “Finish and credit the bounded real demo. I retain the option of a consciously accepted reconnect limitation; I will not call a harness change a product fix.”

🎨 **Sally:** “Fix recovery before calling v0.2 ready. Keep the name, expose a usable recovery action, and state clearly if restarting still requires an explicit replacement decision.”

🏗️ **Winston:** “Use explicit same-Actor replacement for the smallest immediate assisted repair. Do not infer process death from 180 seconds of silence or add a resume subsystem before automatic recovery is required.”

🔒 **Vex:** “A stable Actor key authorizes a deliberate handoff; it does not identify the rightful successor process. Require atomic persistence, incumbent fencing and replay protection; prevent automatic reclaim loops.”

😤 **Grumbal:** “Block release acceptance, retain every valid demo observation, repair the shipped behavior, and qualify new bytes. The soak's deliberate token eviction does not prove normal restart recovery.”

TEAM_DONE astra-lease
