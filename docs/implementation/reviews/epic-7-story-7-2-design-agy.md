# BMAD Party-Mode Round-Table — Story 7.2 Design Ruling: The Observed Incumbent (A6)

- **Task ID:** `story-7-2-design-agy`
- **Lane:** `agy` (Antigravity / Gemini)
- **Target Context:** `agent-room v0.3`, Epic 7 (`docs/epics.md:650–659`) following completed Stories 7.1 (`8a13348`), 7.3, and the formal Story 7.4 refusal (`docs/implementation/reviews/epic-7-a2-recovery-design-codex.md`).
- **Date:** 2026-10-29
- **Mode:** Advisory / READ-ONLY Architecture Ruling (5 Named Voices)

---

## Cast of Voices

- 📋 **John (Product Manager & Ledger Custodian):** Guards scope against Epic 6 retro action `A6` (`epic-6-release-gate-codex.md:28`), enforces additive wire discipline under `A1`, and prevents the takeover protocol from sprawling beyond the manual operator recovery boundary preserved by the Story 7.4 refusal.
- 🏗️ **Winston (Systems & Concurrency Architect):** Owns `server/core/session-registry.mjs` state transitions, monotonic generation indexing, and the in-memory lifecycle of ephemeral tickets versus durable SQLite claims.
- 🔒 **Vex (Security & Session-Authority Reviewer):** Audits same-Actor confidentiality, capability leaks, ticket replay/theft vectors, and guarantees that tickets function strictly as CAS guards rather than ambient bearer credentials.
- 🎨 **Sally (Operator & Client UX Designer):** Owns the CLI confirmation loop (`agent-room session replace` in `server/cli/session-commands.mjs`), ensuring operators are never prompted under false pretenses (e.g. free names or foreign collisions) and that receipts remain strictly factual.
- 😤 **Grumbal (Adversarial Gatekeeper):** Traces every failure path against shipped code (`pipeline.mjs`, `server.mjs`, `session-registry.mjs`), refuses hand-waving on eviction bounds, and tests edge cases like A→release→A and ticket-racing line by line.

---

## Part 1: Ruling on the 7 Draft Design Points

### 1. Ticket Form: Server-Side In-Memory Map vs Durable Store
**Draft:** Opaque random ID (32 bytes, url-safe) stored server-side in a bounded in-memory map `{ ticket -> { actorFingerprint, chatId, incumbentSessionKey, observedGeneration, issuedAt } }`, single-use (burned on consumption), voided on server restart without durable persistence.

#### Round-Table Debate
🏗️ **Winston:** “Pass as an in-memory map. Look at `server/core/session-registry.mjs:56-65`: `liveSessionRegistry` is entirely ephemeral in-memory state. When the daemon restarts, `liveSessionRegistry.clear()` drops every live row, and `sessionRegistry` (`server/api/session.mjs`) resets its tokens. If the incumbent session ceases to exist on daemon reboot, persisting an observation ticket to SQLite makes no architectural sense. Storing it in SQLite would leave zombie tickets pointing to dead session keys from a previous boot epoch, requiring schema migrations and durable pruning. Ephemeral observation belongs with ephemeral occupancy.”

📋 **John:** “Agreed on memory over durable. Our storage admission gate (`server/constants.mjs:STORAGE_REFUSE_RESERVE_BYTES`, Story 4.6) and SQLite write budget exist for genuine room append state and durable claims. Writing transient 30-second CLI handshake tickets to disk creates useless WAL churn and contradicts FR-17. But Winston, you must bound that map explicitly.”

🔒 **Vex:** “Pass on the 32-byte cryptographic random token (`randomBytes(32).toString('base64url')`), but notice: the ticket is **not a capability**. It must store `actorFingerprint` so execution binds to the authenticated caller, `chatId` so it cannot be swapped to another room, `incumbentSessionKey` so it names the specific session, and `observedGeneration` so it pins the occupancy epoch. If the daemon restarts, voiding all outstanding tickets is the only safe outcome; the CLI must simply re-observe.”

😤 **Grumbal:** “PASS, with one strict condition: the memory map must be server-resident in the API daemon (`server/api/server.mjs`), single-use, burned synchronously upon presentation whether the takeover succeeds or fails. If the execution check fails (mismatched incumbent), the ticket is dead. No second chances on a stale ticket.”

**RULING: PASS (In-Memory Confirmed).** Opaque 32-byte URL-safe random string; server-side in-memory Map only; no SQLite persistence; voided on daemon restart.

---

### 2. Issuance: Error Envelope Extras on 409 `chat_id_taken` & Same-Actor Confidentiality
**Draft:** Any `POST /api/session` bind refused with 409 `chat_id_taken` gains a `conflict_ticket` + `observed_generation` in the error envelope's extras — ONLY when the holder's `actorFingerprint` equals the caller's. Foreign callers see exactly today's bare envelope.

#### Round-Table Debate
🔒 **Vex:** “Refine. Same-Actor confidentiality is non-negotiable. If Actor B sends `POST /api/session` with `chat_id: 'Agent'` currently held by Actor A, Actor B must receive the exact pre-Story 7.2 error envelope: `{ ok: false, error: { code: 'chat_id_taken', message: 'chat id is already claimed by another connected session' } }` with status 409. Not a single byte of incumbent metadata, no ticket, and no generation. If we leak a ticket or generation to Actor B, Actor B learns rotation timing of Actor A's private key. But I have a question for Winston: why are we sending `observed_generation` on the wire in the error envelope?”

🏗️ **Winston:** “Vex is right to challenge `observed_generation` on the wire. The client does not do concurrency arithmetic; the client cannot verify generation. When the CLI executes the takeover in Point 4, it submits `conflict_ticket: "<id>"`. The server looks up `<id>` in its in-memory map, which already holds `ticketData.observedGeneration`. Putting `observed_generation` into `RESPONSE_FIELD_VOCABULARY` and `ERROR_ENVELOPE_EXTRAS['chat_id_taken']` exposes internal registry bookkeeping for no functional gain. However, if Sally wants it for diagnostic CLI printing, it can be an additive response extra. But the ticket itself is sufficient.”

🎨 **Sally:** “From the CLI UX perspective, the operator never needs to see a raw integer like `observed_generation: 4`. The operator cares about: `The Chat ID 'Agent' is held by a live session. Replace it? [y/N]`. However, keeping `conflict_ticket` in `chat_id_taken` extras is clean. Furthermore, ordinary MCP clients that collide on startup will receive this envelope if they collide with their own installation key; they simply ignore the extra fields because MCP client code doesn't read `error.conflict_ticket`. Only `agent-room session replace` acts on it.”

📋 **John:** “If `observed_generation` is returned on the wire, it must be added to `RESPONSE_FIELD_VOCABULARY` in `server/api/routes.mjs` and documented in `ARCHITECTURE-SPINE.md`. I rule that we **REFINE** Point 2: return `conflict_ticket` in `chat_id_taken` extras when `holder.actorFingerprint === principal.actorFingerprint`. Returning `observed_generation` on the wire is acceptable as an informative extra, but the server MUST NOT rely on the client echoing it back. The server trusts its own stored `observedGeneration`.”

**RULING: REFINE.** Mint and return `conflict_ticket` (and optionally `observed_generation` as diagnostic extra) in `409 chat_id_taken` extras *strictly* when `holder.actorFingerprint === principal.actorFingerprint`. Foreign Actors receive the legacy bare 409 envelope with zero extras.

---

### 3. Occupancy Identity: Monotonic Generation Counter in `liveSessionRegistry`
**Draft:** A monotonic generation counter per `chat_id` in the live registry, bumped on every claim, transfer, and release. The ticket pins `(incumbentSessionKey, generation)`. At execution, takeover proceeds only if CURRENT `(holder, generation) === observed (incumbentSessionKey, generation)`.

#### Round-Table Debate
😤 **Grumbal:** “Pass. This directly answers the A→free→A hole that I raised during the design gate (`epic-7-design-gate-agy.md:44`). Trace it: Session A holds the name at generation 1. Operator observes Session A at gen 1. While the operator deliberates at the `[y/N]` prompt, Session A calls `DELETE /api/session` (or its lease expires). The name is freed. Generation bumps to 2. Session A (or another process with A's key) comes back online and calls `POST /api/session`. It claims the free name. Generation bumps to 3! If you only checked `holder.sessionKey === incumbentSessionKey`, the new session happens to have the exact same sessionKey (e.g. if the token wasn't revoked or was re-authenticated), and the takeover would evict the newly restored session! With generation bumped on claim, transfer, and release, `current.generation (3) !== ticket.observedGeneration (1)`. Refused!”

🏗️ **Winston:** “Let's be exact about where this counter lives in `server/core/session-registry.mjs`. In `createLiveSessionRegistry()`, alongside `sessions = new Map()` and `names = new Map()`, we maintain `generations = new Map()` keyed by `forms.normalized`. 
- When `claim()` succeeds on an unoccupied name: `generations.set(norm, (generations.get(norm) ?? 0) + 1)`.
- When `transfer()` succeeds: `generations.set(norm, generations.get(norm) + 1)`.
- When `release()` runs: `generations.set(norm, generations.get(norm) + 1)`.
- When `sweepExpired()` removes an expired row: `generations.set(norm, generations.get(norm) + 1)`.
- But what about a rename (`PATCH /api/session`)? The old name is released (bump its gen), and the new name is claimed (bump its gen).
- What about a case-only display refresh (`Agent` -> `agent`) by the same session? In `commit()` lines 240–250, continuous occupancy by the same session key without name change does NOT bump generation. That represents uninterrupted tenure.”

🔒 **Vex:** “Crucial security distinction: the execution check must require that a holder exists. If the name is free at execution time (`holder === null`), takeover MUST NOT proceed, even if somehow generation matched. The check is:
`holder !== null && holder.sessionKey === ticket.incumbentSessionKey && currentGeneration === ticket.observedGeneration`. Both must match.”

**RULING: PASS.** Monotonic integer generation counter per normalized `chat_id` stored in `liveSessionRegistry`, incremented on every discrete occupancy boundary (`claim`, `transfer`, `release`, `sweepExpired`, and rename). Execution verifies both `sessionKey` and `generation`.

---

### 4. Wire Protocol: Request Vocabulary & New Error Code `conflict_stale` (409)
**Draft:** Takeover intent becomes `replace_existing: true, conflict_ticket: "<id>"`. `replace_existing: true` without `conflict_ticket` is refused `400 invalid_request`. A stale/expired/burned ticket is refused with `409 conflict_stale`. Additive Spine amendment and constants update.

#### Round-Table Debate
📋 **John:** “Pass. Let's trace our contract rules in `server/constants.mjs` and `server/api/routes.mjs`.
1. `REQUEST_FIELD_VOCABULARY` adds `'conflict_ticket'`.
2. `ROUTE_TABLE` for `POST /api/session` adds `'conflict_ticket'` to `requestFields`: `['chat_id', 'client_type', 'replace_existing', 'conflict_ticket']`.
3. `PUBLIC_ERRORS` gains:
   `conflict_stale: 'the conflict ticket is invalid, expired, already consumed, or does not match the current incumbent'`.
4. `PUBLIC_ERROR_STATUS` gains:
   `conflict_stale: 409`.
5. `tests/api-contract.test.mjs` live-parses `ARCHITECTURE-SPINE.md:AD-8`. Under rule `A1`, the Spine amendment lands in the same commit as the code changes.
Notice this does NOT violate the frozen wire rule: NFR-8 and AD-8 explicitly allow additive fields and codes when accompanied by a dated Spine amendment.”

😤 **Grumbal:** “Hold on, John. What happens if a caller provides `conflict_ticket` when `replace_existing` is omitted or false? That must be rejected with `400 invalid_request`: `conflict_ticket is only accepted when replace_existing is true`. And what if `replace_existing: true` is sent WITHOUT `conflict_ticket`? The brief says `400 invalid_request`. I endorse that: Story 7.2 deprecates blind takeovers. Takeover requires an observation.”

🔒 **Vex:** “Why is `conflict_stale` a 409 rather than a 400? Because the request shape was valid; the refusal is caused by conflicting state in the session authority (the incumbent moved or the ticket expired). 409 Conflict is the precise HTTP semantic. Furthermore, `PATCH /api/session` does not accept `conflict_ticket` (it never accepted `replace_existing`), so sending it on PATCH triggers `400 unknown_field`.”

**RULING: PASS.** Add `conflict_ticket` to `REQUEST_FIELD_VOCABULARY` and `POST /api/session` route fields; add `conflict_stale: 409` to `PUBLIC_ERRORS` and `PUBLIC_ERROR_STATUS`; enforce mutual requirement (`replace_existing: true` requires `conflict_ticket`); amend `ARCHITECTURE-SPINE.md:AD-8` additively per A1.

---

### 5. CLI Flow: Observation Phase in `agent-room session replace`
**Draft:** `agent-room session replace` observes FIRST. It authenticates as the installation, attempts a plain bind (`POST /api/session` without `replace_existing`), receives 409 + ticket, prompts operator, then sends intent with that ticket. Stale refusal ends command; retry requires new observation.

#### Round-Table Debate
🎨 **Sally:** “REFINE! The draft description has a glaring trap: what happens if the Chat ID is currently FREE?
Look at `server/cli/session-commands.mjs`: if the CLI attempts a plain bind on a free name, **the plain bind succeeds with 200 OK!** The CLI session has now claimed the name!
In v0.2.0, operators ran `session replace` because they suspected a dead session was squatting their name. If the name was actually already free (e.g. lease expired or clean disconnect), what should happen?
If the plain bind succeeds:
1. The CLI did NOT displace anyone (`replaced: false`).
2. There is no incumbent to confirm! Prompting `Take over the Chat ID? [y/N]` when nobody holds it is deceptive and confusing.
3. The CLI should immediately release the name (`DELETE /api/session`) and exit cleanly with:
   `{ ok: true, replaced: false, released: true, note: 'the Chat ID was already free; no live session was displaced' }`.
And what if the name is held by a FOREIGN Actor?
The plain bind returns `409 chat_id_taken` WITHOUT a `conflict_ticket`.
The CLI immediately aborts with: `the Chat ID is held by another key; this installation cannot displace it.`
**Notice how beautiful this is:** The operator is ONLY prompted `[y/N]` when there is a real, same-Actor incumbent and a valid `conflict_ticket` in hand!”

😤 **Grumbal:** “Wait, Sally. Is a plain bind the right way to observe? A plain bind mutates SQLite durable claims (`upsertChatIdClaim`) if the name was free. Is that acceptable?”

🏗️ **Winston:** “Yes, Grumbal. Why? Because `agent-room session replace` is an explicit command run by this Actor on this installation. If the name is free, updating the durable claim to this Actor's own public key is completely harmless. But more importantly: there is NO `GET /api/session` route in `server/api/routes.mjs`. Adding a new GET route just for preflight would require a route table change and new permissions. Reusing `POST /api/session` without `replace_existing` is the canonical, existing bind operation. If it collides (the normal case for takeover), `bindSession` rejects before any durable write or memory commit occurs! So observation of a held name touches no durable state.”

🔒 **Vex:** “And Sally's flow closes a serious UX bug: in v0.2.0, the CLI asked the operator `[y/N]` *before* authenticating or checking the holder (`session-commands.mjs:234–255`). The operator would confirm takeover, only to be rejected a millisecond later because another Actor held the name or the server was down. Observing first guarantees that confirmation is only sought when a legitimate same-Actor takeover is possible.”

**RULING: REFINE.** CLI authenticates first, attempts plain bind (`POST /api/session` with `chat_id`). 
- If 409 with `conflict_ticket`: prompt operator `[y/N]`, then submit `replace_existing: true, conflict_ticket`.
- If 409 without `conflict_ticket`: abort immediately (foreign holder collision, cannot displace).
- If 200 OK: name was already free; CLI immediately calls `DELETE /api/session`, reports `replaced: false, released: true`, and exits without prompting.
- If 409 `conflict_stale` on takeover: print coded refusal and exit; never auto-retry.

---

### 6. Replay, Theft, and Single-Use Semantics
**Draft:** A burned ticket's replay is refused (not in map); a ticket plus a different Actor's authentication is refused at the actor check (ticket is not a credential); theft without Actor key is useless.

#### Round-Table Debate
🔒 **Vex:** “PASS. Let's verify the threat model:
1. **Replay:** When `POST /api/session` receives `conflict_ticket`, the server immediately deletes the ticket from the in-memory map (`tickets.delete(id)`) inside the synchronous request handler before evaluating the transfer. Once deleted, any second request with the same ticket ID fails the lookup and receives `409 conflict_stale`.
2. **Theft / Eavesdropping:** Suppose an attacker on the local machine reads the ticket from memory or loopback traffic. The attacker cannot redeem the ticket unless they also possess the installation's Ed25519 private key (or local token file) to pass `AuthStage`. Furthermore, the server verifies `ticketData.actorFingerprint === principal.actorFingerprint`. Presenting a valid ticket with a foreign session token fails this check.
3. **Cross-Room Confusion:** The ticket record contains `chatId`. If an attacker or buggy script presents a ticket issued for `Agent-A` on a takeover request for `Agent-B`, the server verifies `ticketData.chatId === requestedChatId`. Mismatch results in `409 conflict_stale`.”

🏗️ **Winston:** “And note the execution atomicity: in Node.js, `bindSession` runs on the single-threaded event loop. Looking up the ticket, verifying the incumbent in `liveSessionRegistry`, calling `store.upsertChatIdClaim`, updating `liveSessionRegistry`, and deleting the ticket from `tickets` happen synchronously in one turn without an intervening `await`. There is no TOCTOU window between ticket validation and registry mutation.”

**RULING: PASS.** Tickets are single-use CAS tokens bound to `{ actorFingerprint, chatId, incumbentSessionKey, observedGeneration }`, burned synchronously upon first evaluation.

---

### 7. Test Flips and Regression Matrix
**Draft:** The two-sequential-takeovers row (`tests/session-replacement.test.mjs:264–288`) flips: the second takeover with the first's ticket is refused `conflict_stale`; with a fresh observation it succeeds. New rows cover foreign collisions, A→release→A reclaim, ordinary reconnects, and unauthenticated attempts.

#### Round-Table Debate
😤 **Grumbal:** “PASS. Let's audit `tests/session-replacement.test.mjs:264-288`:
Currently, lines 273–280 execute:
```javascript
const takeTwo = await sessionRequest(server.port, 'POST', second, {
  chat_id: 'Agent', client_type: 'mcp', replace_existing: true,
})
const takeThree = await sessionRequest(server.port, 'POST', third, {
  chat_id: 'Agent', client_type: 'mcp', replace_existing: true,
})
assert.equal(takeThree.status, 200)
```
This test explicitly codified the defect A6 flagged: ‘the last explicit intent wins, and the loser is fenced.’
Under Story 7.2:
1. `takeTwo` must obtain a ticket from an initial plain bind collision. It presents `conflict_ticket: ticket2` and succeeds (`status: 200`).
2. If `takeThree` tries to execute with `ticket1` (or without a ticket), it is refused (`409 conflict_stale` or `400 invalid_request`).
3. If `takeThree` observed before `takeTwo` ran, its ticket pinned Session 1 at gen 1. When `takeThree` attempts to execute after `takeTwo` replaced Session 1 with Session 2 (gen 2), `takeThree` MUST BE REFUSED with `409 conflict_stale`!
4. Only when `takeThree` performs a NEW plain bind, observes Session 2 at gen 2, receives `ticket3`, and presents `ticket3` does it succeed!”

📋 **John:** “We also need four specific new regression tests:
- `test('takeover without conflict_ticket is rejected with 400 invalid_request')`
- `test('foreign actor collision on held chat_id receives bare 409 without conflict_ticket')`
- `test('A->release->A sequence invalidates outstanding conflict ticket with conflict_stale')`
- `test('ordinary client reconnect without replace_existing never requires or receives conflict_stale')`.”

**RULING: PASS.** Flip the sequential-takeover test to assert `409 conflict_stale` on stale incumbent; add all four regression tests.

---

## Part 2: Ruling on Specific Design Questions (a–e)

### Question (a): Does execution-time comparison use `(sessionKey, generation)` or `generation` alone? Which survives the A→free→A case correctly?

#### Round-Table Debate
🏗️ **Winston:** “Execution-time comparison MUST use the pair `(sessionKey, generation)`. 
Let's trace both options through the A→free→A sequence:
1. State: `Chat ID = 'Agent'`, `holder = SessionKey_A`, `generation = 1`.
2. Observation: Ticket $T$ issues, pinning `(incumbentSessionKey: SessionKey_A, observedGeneration: 1)`.
3. Disconnect: Session A calls `DELETE /api/session`. `liveSessionRegistry.release()` clears the row and increments generation to 2 (`holder = null`, `generation = 2`).
4. Re-bind: Session A calls `POST /api/session` with the same token (re-auth recovery / reconnect). `claim()` binds the name and increments generation to 3 (`holder = SessionKey_A`, `generation = 3`).
5. Takeover attempt with Ticket $T$:
   - If we compared `sessionKey` alone: Current holder is `SessionKey_A`. Ticket incumbent is `SessionKey_A`. They match! The takeover would wrongfully succeed and evict the legitimate new occupancy! Thus, `sessionKey` alone **FAILS** the A→free→A case.
   - If we compared `generation` alone: Current generation is 3. Ticket generation is 1. $3 \neq 1$. It refuses with `conflict_stale`.
   - If we compare `(sessionKey, generation)`: `(SessionKey_A, 3) !== (SessionKey_A, 1)`. Refuses with `conflict_stale`.”

🔒 **Vex:** “Why not compare `generation` alone? Why do we need `sessionKey`?
Because relying on `generation` alone detaches occupancy from cryptographic principal identity! If a bug in generation bumping occurs, or if the name became free (`holder === null`), checking `generation` alone might allow a takeover to run against a non-existent incumbent. 
Furthermore, look at `server/core/session-registry.mjs:292`:
`transfer({ sessionKey, chatId, actorFingerprint, clientType, persist, incumbentSessionKey })`
`transfer()` requires `incumbentSessionKey` to delete the incumbent from `sessions` Map! 
Checking both guarantees:
1. There is an incumbent holding the name.
2. The incumbent is the exact session key observed.
3. The occupancy generation has not shifted by even a single release/re-claim.
Both survive A→free→A, but `(sessionKey, generation)` is semantically complete and cryptographically sound.”

**RULING:** Comparison MUST use the full pair `(incumbentSessionKey, observedGeneration)`. `sessionKey` alone fails A→free→A; `generation` alone discards identity and violates the `transfer()` contract.

---

### Question (b): Should the ticket observation REQUIRE authentication? Can an unauthenticated caller ever receive a ticket?

#### Round-Table Debate
🔒 **Vex:** “Ticket observation MUST strictly require authentication. An unauthenticated caller must NEVER receive a conflict ticket under any circumstance.
Three definitive architectural reasons:
1. **Same-Actor Confidentiality Rule:** A conflict ticket is only issued when `incumbent.actorFingerprint === caller.actorFingerprint`. An unauthenticated caller has no authenticated fingerprint. To give an unauthenticated caller a ticket would require either giving tickets to anyone (a catastrophic leak of session rotation handles to attackers) or guessing identity.
2. **Route Class Boundary (AD-7):** `POST /api/session` is in route class `'actor'`. Under `server/api/pipeline.mjs:runPipeline`, every actor route passes through `AuthStage`, which executes `SessionVerifier`. An unauthenticated request is halted at admission with `401 unauthorized` before `bindSession` or `liveSessionRegistry` is ever reached.
3. **DoS Vector:** If unauthenticated callers could mint tickets, an external port-scanner could flood the server's ticket map with millions of entries, triggering memory exhaustion.”

📋 **John:** “This was already settled by Vex's ruling in the Epic 7 design gate (`epic-7-design-gate-agy.md:44`) and codified in `docs/epics.md:658`: *'The ticket is SAME-ACTOR CONFIDENTIAL: a foreign Actor colliding with a held name receives the bare chat_id_taken with no ticket and no incumbent metadata.'* An unauthenticated caller is by definition not proven to be the same Actor. No ticket is ever minted or returned without valid session authentication.”

**RULING:** Ticket observation REQUIRES authentication. Unauthenticated callers are rejected at `AuthStage` with `401 unauthorized` and never receive a ticket.

---

### Question (c): Error Vocabulary: Confirm `conflict_stale` (409) and Any Other Required Codes

#### Round-Table Debate
📋 **John:** “We confirm `conflict_stale` with HTTP status `409 Conflict`.
Does the frozen vocabulary need anything else?
Let's audit all error cases:
- Missing `conflict_ticket` when `replace_existing: true` is sent -> `400 invalid_request` (existing code).
- Non-string or malformed `conflict_ticket` -> `400 invalid_request` (existing code).
- Extra unknown field in JSON body -> `400 unknown_field` (existing code).
- Collision with foreign Actor's held name -> `409 chat_id_taken` (existing code).
- Stale, expired, unknown, or mismatched ticket -> `409 conflict_stale` (NEW code).
No other error codes are needed. The frozen vocabulary gains exactly ONE error code (`conflict_stale`), ONE request field (`conflict_ticket`), and ONE response field in error envelope extras (`conflict_ticket`, plus optional `observed_generation`).”

😤 **Grumbal:** “Confirmed. `conflict_stale` cleanly covers:
1. Ticket not found in memory (burned, never issued, or server restarted).
2. Ticket expired past TTL.
3. Ticket's `chatId` does not match the request `chat_id`.
4. Ticket's `actorFingerprint` does not match the authenticated caller.
5. Current holder does not match `ticket.incumbentSessionKey`.
6. Current generation does not match `ticket.observedGeneration`.
Collapsing these six into `conflict_stale` prevents leaking fine-grained timing discrepancies while giving the operator a clear diagnostic: your observation is no longer fresh.”

**RULING:** Confirm `conflict_stale` at `409 Conflict`. No additional error codes required; request shape errors map to existing `400 invalid_request`.

---

### Question (d): Bounded-Map Eviction: TTL and Bound (Applying the Fence's Lesson)

#### Round-Table Debate
😤 **Grumbal:** “Here is where most implementations create a security hole. Remember Story 7.1! In Story 7.1, the superseded fence used a naive bound (`maxSessions = 1000`) and evicted oldest entries FIFO. If 1,000 new sessions connected, an active displaced session's fence tombstone was evicted while its HTTP request was still in-flight!
What is the fence's lesson for conflict tickets?
**Never evict a ticket that can still be legally redeemed inside its own window!**
If you have a fixed bound (say 500 tickets) and an operator is reading the prompt `[y/N]`, what happens if another process or script triggers 500 collisions? If you use FIFO eviction, the operator's ticket gets deleted before they can press 'y'! That is an eviction hazard.”

🏗️ **Winston:** “Let's calculate the real numbers:
1. **TTL:** How long does an operator need to read a CLI prompt and type `y`?
   - 10 seconds is tight for a human.
   - 60 seconds (`CONFLICT_TICKET_TTL_MS = 60_000`) is the standard operator confirmation window. After 60 seconds, an observation SHOULD be considered stale because the likelihood of incumbent state changes increases.
2. **Capacity Bound & Eviction Strategy:**
   - Who can mint a conflict ticket? ONLY an authenticated session of the SAME Actor colliding with an already-held Chat ID!
   - Can an external attacker flood the map? NO, foreign callers get no tickets.
   - How many Chat IDs can one installation hold concurrently? Typically 1 to 5.
   - If we set `CONFLICT_TICKET_MAX = 1000`, the server can hold 1,000 concurrent active tickets.
   - **Eviction rule:** On every issuance, purge tickets where `now() - issuedAt > CONFLICT_TICKET_TTL_MS`. If `tickets.size >= CONFLICT_TICKET_MAX` after purging expired tickets: **DO NOT evict unexpired tickets via FIFO!** Instead, refuse to issue a new ticket (return bare `409 chat_id_taken` without ticket) or overwrite ONLY an unconsumed ticket previously issued to the *same* `(actorFingerprint, chatId)` pair!
   - Because a single Actor on a single Chat ID only needs AT MOST ONE active ticket at any moment, keying or replacing the prior unconsumed ticket for the same `(actorFingerprint, chatId)` bounds ticket allocation per name to exactly 1!”

🔒 **Vex:** “That is the exact correct design: **Per-(Actor, Chat ID) slotting with a hard TTL**.
If Actor A collides on 'Agent' five times in 10 seconds, Actor A gets a fresh ticket and the previous unconsumed ticket for 'Agent' is invalidated. Actor A cannot consume 1,000 slots for the same name. Unexpired tickets for *other* Chat IDs are never evicted by a busy loop on 'Agent'.
TTL = 60,000 ms (60 seconds). Bound = 1,000 tickets. Expired tickets pruned on every access.”

**RULING:** `CONFLICT_TICKET_TTL_MS = 60_000` (60 seconds). Hard cap of 1,000 tickets. Never evict unexpired tickets belonging to distinct names via FIFO; re-observing the same `(actorFingerprint, chatId)` replaces that pair's outstanding ticket. Expired entries purged lazily.

---

### Question (e): Conflicts with Prior Recorded Decisions

#### Round-Table Audit
📋 **John:** “Let's systematically audit against the recorded architectural ledger:
1. **Release Never Carries Intent:** Ratified in Epic 1 and preserved in Epic 6. `DELETE /api/session` is strictly a release; it takes no request body and carries no takeover intent. Story 7.2 leaves `DELETE /api/session` completely untouched. (Clean pass).
2. **Durable Claim Before Memory:** Ratified in Story 1.5 (`server/core/session-registry.mjs:252-258`). The SQLite write `upsertChatIdClaim` must run and commit *before* the in-memory `sessions` and `names` Maps mutate. In Story 7.2, ticket validation and generation checks run *before* the durable write. If the ticket is stale, the durable write never executes. If the durable write fails, memory is untouched. (Clean pass).
3. **The Story 7.1 Fence:** Story 7.1 ensures that a displaced session key is added to `superseded`, its in-flight requests are pinned until pipeline completion, and post-input revalidation refuses any pending mutation. Story 7.2 directly invokes this fence: when `transfer()` succeeds against the verified incumbent, the displaced session key is passed to `sessionRegistry.supersede(displaced)` exactly as before. (Clean pass).
4. **FR-15 (Ban Semantics):** Operator bans take effect at next admission and long-poll wake, not mid-flight. Story 7.2 does not alter ban checks. (Clean pass).
5. **Story 7.4 Automatic Recovery Refusal:** Story 7.4 formally refused unattended automatic crash recovery (`docs/implementation/reviews/epic-7-a2-recovery-design-codex.md`). Manual takeover via `agent-room session replace` is the sole authorized recovery path. Story 7.2 hardens this exact manual path against stale race conditions without introducing any automatic recovery daemon or ambient disk tokens. (Clean pass).”

😤 **Grumbal:** “No conflicts found. Every invariant from Stories 1.5, 4.6, 6.4, 7.1, 7.3, and 7.4 is preserved intact.”

**RULING:** Zero conflicts with prior decisions. Complete architectural alignment across the ledger.

---

## Part 3: Explicit Statement of Unverified Items

In accordance with our strict verification discipline, the following items could not be mechanically verified in this advisory phase because implementation code has not yet been authored:
1. **Live HTTP Soak Behavior Under Sustained Ticket Issuance:** We verified the in-memory map logic theoretically, but the exact V8 heap retention of 1,000 short-lived ticket objects under high concurrency has not been measured under `--trace-gc`. This must be validated during Story 7.6 or during Story 7.2's implementation tests.
2. **Terminal Prompt Formatting in Non-Standard TTYs:** The revised CLI observation flow avoids prompting on free names, but raw terminal escape behavior in restricted terminal emulators (e.g. Windows terminal wrappers or CI PTY allocators) must be verified when `session-commands.mjs` is edited.

---

## Part 4: Each Voice's Bottom Line

- 📋 **John (Product Manager & Ledger Custodian):**
  > **PASS WITH AMENDMENT.** Story 7.2 is the definitive closure of retro action A6. The wire protocol expands additively with `conflict_ticket` on requests, `conflict_ticket` in 409 extras, and `conflict_stale` (409) in `PUBLIC_ERRORS`. The Architecture Spine amendment must land in the same commit per rule `A1`. Unattended recovery remains dead; manual takeover is now bulletproof.

- 🏗️ **Winston (Systems & Concurrency Architect):**
  > **PASS WITH PAIR MATCHING.** Monotonic generation counters per normalized Chat ID in `liveSessionRegistry` combined with `incumbentSessionKey` solve both stale takeovers and the A→free→A hazard cleanly. Storing tickets in an ephemeral server-side Map with 60-second TTL perfectly aligns with our in-memory session architecture.

- 🔒 **Vex (Security & Session-Authority Reviewer):**
  > **PASS WITH STRICT CONFIDENTIALITY.** Same-Actor confidentiality is preserved: foreign callers colliding with a held name receive the legacy bare 409 envelope with zero metadata and no ticket. Tickets are single-use CAS tokens tied to the authenticated Actor, unusable without the installation's private key.

- 🎨 **Sally (Operator & Client UX Designer):**
  > **PASS WITH OBSERVE-FIRST CLI.** `agent-room session replace` now authenticates and observes before prompting the operator. If the name is free, it releases and exits without bothering the human; if a foreign key holds it, it aborts immediately. Operators are only prompted when a legitimate, actionable takeover is ready to execute.

- 😤 **Grumbal (Adversarial Gatekeeper):**
  > **PASS WITH TEST FLIPS.** The sequential-takeovers test that let competing takeovers blindly succeed is officially marked for flipping. The second takeover without a fresh observation must fail with `409 conflict_stale`. Bounded eviction must never drop unexpired tickets of distinct names via FIFO.

---

TEAM_DONE story-7-2-design-agy
