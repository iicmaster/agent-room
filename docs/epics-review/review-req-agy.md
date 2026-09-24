# Review: requirements inventory → agy-advisor

> Provenance: task `epics-req-review-agy`, effective_identity `gemini-3.7-flash-high (matched)`, receipt-backed ACP dispatch, completed 2026-09-20 07:54. Verbatim outbox capture.

# Agent Room v0.2 Requirements Inventory Review (Pre-Epic Gate)

**Task ID:** `epics-req-review-agy`  
**Review Target:** `/Users/ngs/agent-skills/plugins/agent-room/docs/epics.md` (Requirements Inventory: FR1–FR22, NFR1–NFR8, AR1–AR17, UX Section)  
**Sources:**
- Source 1 (PRD): `docs/prds/prd-agent-room-2026-09-20/prd.md`
- Source 2 (Architecture Spine): `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md`
- Source 3 (Decision Record D1–D19): `docs/prds/prd-agent-room-2026-09-20/addendum.md`

---

## 1. Executive Summary & Cast

This review audits the Requirements Inventory in `docs/epics.md` before epic and story breakdown begins. Catching fidelity errors, missing contracts, compound requirements, and architectural sequencing traps here prevents broken epics downstream.

### The Round-Table Cast
- **John (Product Manager):** Focused on release scope, product boundaries, release gates (Agent Plugins 1.0, SM-1..SM-4), and user journey fidelity.
- **Sally (UX & Ergonomics Lead):** Champion of developer ergonomics, CLI interactions, human-in-the-loop approval flows, and error clarity.
- **Grumbal (The Adversary / Security & Failure-Mode Specialist):** Ruthless critic looking for race conditions, spoofing vectors, data collisions, wire protocol deadlocks, and hidden edge cases.
- **Maya (Systems & Architecture Specialist):** Guardian of hexagonal core isolation, state machine determinism, SQLite transaction boundaries, and epic dependency graphs.

---

## 2. Severity-Ranked Findings

```
================================================================================
CRITICAL FINDINGS (Must fix in inventory before epic design)
================================================================================
```

### CRIT-1: Pair ID Keying Formula Collision Risk (Spine AD-6 Typo Papered Over)
- **Requirement IDs:** `AR6`, `FR7`
- **Source Line Quoted (Architecture Spine line 79):**
  > `Direct Rooms key on the canonical unordered actor-pair id — direct:<min(fprA,fprB)> where both fingerprints may be equal (same-Actor room, D14).`
- **Inventory Line Quoted (`docs/epics.md` line 60):**
  > `AR6 (AD-6): ... direct rooms keyed direct:<min,max fingerprints>, both may be equal.`
- **Defect Analysis:** In `ARCHITECTURE-SPINE.md` line 79, the formula is written with a severe typo: `direct:<min(fprA,fprB)>` (only taking the minimum fingerprint!). If implemented literally from Spine AD-6, all Direct Rooms involving actor `A` where `A < B` and `A < C` would map to the exact same room ID `direct:A`, causing room collisions and leaking private DMs between distinct pairs! While `epics.md` AR6 silently patched this to `direct:<min,max fingerprints>`, it left the delimiter unspecified (comma? colon? sorted tuple?) and failed to flag the underlying contradiction with Spine Open Question 2 (`direct:<min,max>`).
- **Required Fix:** Explicitly standardize the canonical pair key string format in AR6/FR7 as `direct:<min_fingerprint>:<max_fingerprint>` (or lexicographically sorted joined by colon) and declare self-DMs as `direct:<fingerprint>:<fingerprint>`.

### CRIT-2: Send Status Enum Omission (`duplicate_dropped` Missing in FR17)
- **Requirement IDs:** `FR17`, `FR16`, `AR8`
- **Source Lines Quoted:**
  - PRD FR-17 line 278:
    > `The Server returns actionable statuses for every send it processes: committed (with room, sequence, idempotency key), rate_limited, banned, storage_low, and client_message_id_conflict.`
  - PRD FR-16 line 270:
    > `...returns duplicate_dropped naming the original sequence — an explicit notice, never a silent success...`
  - Spine AD-8 line 113:
    > `Send semantics: response status is exactly one of committed | rate_limited | duplicate_dropped | storage_low | client_message_id_conflict | banned`
- **Inventory Line Quoted (`docs/epics.md` line 35):**
  > `FR17: Sender notices — statuses committed/rate_limited/banned/storage_low/client_message_id_conflict; client-side outcome_unknown resolved by idempotent retry (FR-20).`
- **Defect Analysis:** PRD FR-17 suffered from a drafting omission where `duplicate_dropped` was omitted from its status enumeration even though FR-16 and Spine AD-8 explicitly require `duplicate_dropped` as one of the 6 frozen send outcome statuses. The inventory mechanically copied PRD FR-17 without catching this gap. An epic author implementing FR17 in isolation will create an incomplete status handler/enum that fails to handle the 5-second duplicate gate response.
- **Required Fix:** Update FR17 in `epics.md` to list all 6 mutually exclusive statuses: `committed`, `rate_limited`, `duplicate_dropped`, `storage_low`, `client_message_id_conflict`, `banned`.

### CRIT-3: Missing `room_status` Tool & `ambiguous_chat_id` Resolution in FR21
- **Requirement IDs:** `FR21`, `AR8`, `AR14`
- **Source Lines Quoted (PRD FR-21 lines 201, 206):**
  > `...room_status names the current realm and Broadcast Room ID.`
  > `...when an offline Chat ID was last held by multiple enrolled Actors, room_direct_open returns ambiguous_chat_id with candidate key fingerprints and last-seen times for human disambiguation — it never guesses.`
- **Inventory Line Quoted (`docs/epics.md` line 39):**
  > `FR21: MCP tool surface — room_presence({include_offline?}), room_direct_open({chat_id}), keep message_send/message_read; descriptions carry "list agents" phrasing + Agent Room identity; distinguish from native Claude Code tools; no native-named aliases; concurrent opens return the same room.`
- **Defect Analysis:** `epics.md` FR21 dropped two essential protocol specifications:
  1. `room_status` tool: Required by agents to discover `realm_id` and the Broadcast Room ID (which keys all local plugin state per AR14).
  2. `ambiguous_chat_id` error contract: Required when opening a DM to an offline Chat ID previously used by multiple actors.
  Without these in the inventory, story writers will miss the `room_status` tool and fail to specify deterministic handling for offline name ambiguity.
- **Required Fix:** Restore `room_status` to the tool list in FR21 and explicitly document the `ambiguous_chat_id` response schema with candidate fingerprints and last-seen timestamps.

### CRIT-4: Unexempted Wire Protocol Header Breaking Web Viewer & Health Probes
- **Requirement IDs:** `NFR8`, `AR1`, `AR7`, `AR8`
- **Source Lines Quoted:**
  - PRD NFR-8 line 317:
    > `Static viewer assets and the local MCP stdio handshake are outside this header contract.`
  - Spine AD-8 line 110:
    > `viewer: GET /viewer/auth · GET /viewer/ + static assets · GET /viewer/api/rooms/:id/messages · GET /viewer/api/rooms/:id/events (SSE)`
- **Inventory Line Quoted (`docs/epics.md` line 51):**
  > `NFR8: Wire protocol versioning — Agent-Room-Protocol: 1 header on every request; 400s for missing/malformed/unsupported; rejection changes no state...`
- **Defect Analysis:** NFR8 in `epics.md` states `Agent-Room-Protocol: 1 header on every request` without qualifying the exemptions. Standard web browsers requesting `/viewer/` HTML/CSS/JS and unauthenticated load balancer probes pinging `GET /health` do NOT send custom application headers. If the middleware pipeline implements NFR8 as written in `epics.md`, the web viewer and health checks will immediately fail with HTTP 400 `protocol_required`.
- **Required Fix:** Update NFR8 and AR7 in `epics.md` to explicitly state: `Agent-Room-Protocol: 1 is mandatory on all /api/* routes; static viewer assets (/viewer/*) and GET /health are exempt.`

---

```
================================================================================
HIGH FINDINGS (Major architectural and story decomposition risks)
================================================================================
```

### HIGH-1: FR10 (Held Messages) is Heavily Overloaded and Hides a Historical Read Gap
- **Requirement IDs:** `FR10`, `FR8`, `AR12`
- **Source Lines Quoted (PRD FR-10 lines 191, 197; PRD FR-20 line 244):**
  > `...The 100-entry held cap bounds a local listing/cache; overflow is explicit and recoverable from the durable log — cache eviction never deletes, approves, or permanently skips a message.`
  > `...advancing a cursor is a client-side act after a successful read, independent of ingestion decisions (held messages still advance the read cursor; ingestion is a separate, human-gated step).`
- **Inventory Line Quoted (`docs/epics.md` line 28):**
  > `FR10: Held Messages — metadata-only (no body text) for non-allowlisted senders; default matrix (own Actor/same-OS-user local/allowlisted remote deliver; all other remote held); per-Realm Allowlist bound to key fingerprints; one-step human-operated release (agent-room allow) + remove action; 100-entry cache cap is recoverable, never deletion; accept-all per-realm opt-in.`
- **Defect Analysis:**
  1. **Decomposition Hazard:** FR10 combines 5 distinct subsystems: (a) response metadata redaction, (b) local SQLite/JSON Allowlist storage, (c) multi-hop trust matrix evaluation, (d) human terminal approval CLI (`agent-room allow`), and (e) 100-entry bounded cache with log recovery.
  2. **API Read Gap:** If a held message advances the client's read cursor (FR20), and is later evicted from the 100-entry local cache, the human releasing it requires fetching the full body text from the server. But `GET /api/rooms/:id/messages` only accepts `after_seq` (AD-8). The inventory fails to specify whether the client performs an historical point read (`after_seq = seq - 1, limit = 1`) or if dedicated single-message retrieval is needed.
- **Required Fix:** Split FR10 into distinct sub-requirements (Redaction Pipeline, Allowlist Storage & Matrix, Human CLI Action, Held Cache Eviction/Log Recovery) and clarify the exact query pattern for recovering evicted held message bodies.

### HIGH-2: FR14 (Invite Lifecycle) Combines Crypto, CLI, and Missing Proxy Trust Semantics
- **Requirement IDs:** `FR14`, `FR4`, `AR7`, `AR9`
- **Source Line Quoted (PRD FR-14 line 260):**
  > `Enrollment attempts are rate-limited (5/minute/source-IP, burst 5; forwarded addresses trusted only from an explicitly configured proxy).`
- **Inventory Line Quoted (`docs/epics.md` line 32):**
  > `FR14: Invite Token lifecycle — ar_inv1_ format (32 random bytes, SHA-256 stored, shown once); default 1 use/24h; finite --uses/--ttl only; atomic single-transaction consume with possession proof first; races yield exactly one enrollment; lost-response retry reattaches; revoke/expiry block new enrollment only; enrollment rate-limited 5/min/IP.`
- **Defect Analysis:** The inventory dropped `forwarded addresses trusted only from an explicitly configured proxy`. In a standard deployment with Caddy reverse proxy (FR4), all requests arrive at the Room Server from `127.0.0.1`. If the server naively inspects `X-Forwarded-For` without proxy trust configuration, remote attackers can spoof their IP to bypass the 5/min limit. If it ignores `X-Forwarded-For`, all remote users share the `127.0.0.1` bucket, causing false-positive 429 lockouts.
- **Required Fix:** Reinstate `--trusted-proxy` / proxy-header validation in FR14 and AR7.

### HIGH-3: The "UX: None" Illusion and Missing Human-Interface Contracts
- **Requirement IDs:** `UX Section`, `FR10`, `FR19`, `FR21`, `FR14`, `FR22`
- **Inventory Line Quoted (`docs/epics.md` line 75):**
  > `UX Design Requirements: None — no UX design contract exists. The only UI is the read-only viewer extended from v0.1's existing web assets per FR-18; no new screen design is required.`
- **Defect Analysis:** Declaring "UX Requirements: None" creates a major blindspot. Agent Room v0.2 introduces significant human-facing CLI interactions:
  - Human terminal approval: `agent-room allow <chat-id>` and `agent-room allow list/remove` (FR10).
  - First-run Chat ID interactive prompt in Local Mode (FR1/FR19).
  - Operator CLI tooling: `agent-room invite mint|list|revoke`, `agent-room ban`, `agent-room status` (FR14, FR15, FR22).
  - Ambiguous Chat ID human resolution output (FR21).
  If epics treat UX as non-existent, CLI outputs, exit codes, interactive prompts, and error messaging will be neglected during story design.
- **Required Fix:** Replace "None" with an explicit **CLI & Human Interaction Requirements** section defining command syntax, interactive prompt behavior, and error rendering.

### HIGH-4: Local Mode Bootstrap Dependency Deadlock in Epic Sequencing
- **Requirement IDs:** `FR1`, `AR1`, `AR4`, `AR5`, `AR7`, `AR10`
- **Defect Analysis:** In v0.1, Local Mode ran over a Unix domain socket. In v0.2, Local Mode is unified onto the HTTP API (AR1). However, Local Mode requires:
  1. Store Schema v2 (`BEGIN IMMEDIATE` transactions) (AR4).
  2. HTTP API Server & Middleware Pipeline (AR7).
  3. Ephemeral Port & Session Token Auth (`POST /api/auth/local` with 0600 token file) (AR5, AR10).
  4. Client `ensureServer` lifecycle management with hardlink locking (AR10).
  An epic sequencing plan that attempts to deliver "FR1 (Local Mode)" as Epic 1 will stall because Local Mode is no longer a simple standalone script—it is the full HTTP stack operating over loopback.
- **Required Fix:** The epic breakdown must establish the architectural spine first (Store v2 -> HTTP Server & Pipeline -> Auth & Identity) before assembling the end-to-end Local Mode experience.

---

```
================================================================================
MEDIUM FINDINGS (Edge cases, lifecycle bounds, and testability)
================================================================================
```

### MED-1: Unspecified Nonce Lifecycle & Replay Resistance in Challenge Auth
- **Requirement IDs:** `FR3`, `AR5`, `AR11`
- **Source Line Quoted (PRD FR-3 line 102):**
  > `...authentication is a fresh possession proof per connection with replay resistance.`
- **Inventory Line Quoted (`docs/epics.md` line 21):**
  > `FR3: Identity Key and Enrollment — ...reconnection re-proves possession (challenge-response), never re-enrolls...`
- **Defect Analysis:** The inventory specifies challenge-response auth but omits nonce storage, expiration (e.g. 60s TTL), and single-use consumption semantics. Without these, story authors may implement static or non-expiring nonces vulnerable to replay attacks.
- **Required Fix:** Specify in AR5 that nonces are single-use, cryptographically random (≥16 bytes), and expire within 60 seconds.

### MED-2: Viewer Authentication Handshake and Cookie Minting Decomposition
- **Requirement IDs:** `FR18`, `AR7`, `AR8`
- **Source Line Quoted (Spine AD-7 line 88):**
  > `viewer (/viewer/*, viewer SSE) — authenticated by an HttpOnly, SameSite=Strict cookie minted via GET /viewer/auth (presenting the viewer token as a Bearer header)... no credential ever travels in a query string...`
- **Inventory Line Quoted (`docs/epics.md` line 36):**
  > `FR18: Read-only viewer — GET-only + SSE, cookie-authed (HttpOnly SameSite=Strict via /viewer/auth); no credential in query strings...`
- **Defect Analysis:** Browser `EventSource` (SSE) cannot send custom HTTP authorization headers. The cookie-minting step via `GET /viewer/auth` is the critical bridge that allows query-string-free SSE auth. This needs dedicated acceptance criteria in viewer stories so implementers don't revert to URL query token parameters.
- **Required Fix:** Ensure the viewer epic includes a dedicated story for the `/viewer/auth` Bearer-to-Cookie exchange and CORS/SameSite=Strict cookie isolation.

### MED-3: Migration v1→v2 Daemon Absorption and In-Flight Sequence Reset
- **Requirement IDs:** `AR4`, `AR17`, `FR11`
- **Source Line Quoted (Spine AD-4 line 67):**
  > `The migration itself is one startup step on a v0.1 database: absorb or stop any live v0.1 daemon first (pid from runtime.json), then a single BEGIN IMMEDIATE transaction performs detect (user_version) → re-sequence + reply remap → stamp v2 — a crash mid-migration resumes idempotently on next boot. Re-sequencing is a one-time, documented cursor reset at upgrade...`
- **Inventory Line Quoted (`docs/epics.md` line 58):**
  > `AR4 (AD-4): Schema v2 — messages keyed (room_id, seq), per-room counter inside write transaction; migration v1→v2 = one startup step (absorb live v0.1 daemon, single BEGIN IMMEDIATE: detect → re-sequence + reply_to_seq remap → stamp v2, idempotent on crash); reply threading survives.`
- **Defect Analysis:** The migration is atomic, but re-sequencing resets message sequences to 1 per room. If an active v0.1 client is running, absorbing the daemon kills in-flight cursors. Story writers need clear acceptance criteria for verifying that `user_version = 2` is stamped and that legacy v0.1 `runtime.json` sockets are cleaned up without data loss.
- **Required Fix:** Ensure AR4 story acceptance criteria explicitly test daemon SIGTERM/absorption, `user_version` state checks, and reply thread remapping.

---

```
================================================================================
LOW FINDINGS (Nits, bounds, and documentation polish)
================================================================================
```

### LOW-1: Missing Explicit Proxy Timeout Bound in FR4
- **Requirement IDs:** `FR4`, `AR15`
- **Source Line Quoted (PRD FR-4 line 113):** `...proxy timeouts ≥30 s...`
- **Inventory Line Quoted (`docs/epics.md` line 22):** `...proxy timeouts/no secrets in logs.`
- **Defect Analysis:** The inventory notes "proxy timeouts" but drops the specific `≥30 s` bound required to prevent reverse proxies from severing 20s long-polls prematurely.
- **Required Fix:** Explicitly state `proxy timeouts ≥30 s` in FR4.

### LOW-2: Explicit Offline Bucket Non-Expiry Guarantee in FR5
- **Requirement IDs:** `FR5`
- **Source Line Quoted (PRD FR-5 line 138):** `...the offline bucket never implies enrollment expiry.`
- **Defect Analysis:** The inventory mentions the 24h offline bucket but omits the explicit statement that dropping out of the 24h offline window does not unenroll the actor.
- **Required Fix:** Add a note to FR5 confirming enrollment permanence.

---

## 3. The Round-Table Debate (bmad-party-mode)

**John (PM):** Team, we have the PRD, Architecture Spine, and D1–D19 locked. The inventory in `docs/epics.md` is our foundation for generating epics. Looking at the functional requirements, FR1 through FR22 match the numbered PRD items. But we need to make sure story writers don't stumble over missing contracts.

**Sally (UX):** John, I have to stop you right there. Look at line 75 of `docs/epics.md`: *"UX Design Requirements: None — no UX design contract exists."* Are you serious? We have a complete human-in-the-loop terminal command suite for FR10 (`agent-room allow <chat-id>`, listing held messages, removing allowlist entries), we have interactive Chat ID selection for FR1/FR19, and we have operator CLI commands for minting invites and banning bad actors in FR14 and FR15. Calling that "None" because it's not a React UI is how we get completely unusable CLI tools with cryptic errors and zero help text!

**Grumbal (The Adversary):** Sally is right about the blindspots, but look at the security and protocol landmines in this inventory. Look at **CRIT-1**. In Spine AD-6, someone wrote `direct:<min(fprA,fprB)>`—taking *only* the minimum fingerprint! If an engineer implemented AD-6 directly from the spine, Alice talking to Bob and Alice talking to Charlie would both get mapped to `direct:Alice`! All their private DMs would merge into one shared room. `epics.md` AR6 changed it to `direct:<min,max fingerprints>`, but didn't define the separator or structure. That is an catastrophic privacy leak waiting to happen.

**Maya (Architecture):** Good catch on the pair ID formula, Grumbal. And look at **CRIT-4** regarding NFR8. The inventory says `Agent-Room-Protocol: 1 header on every request`. If the middleware enforces that blindly across the board, the static web viewer (`GET /viewer/`) and load-balancer health checks (`GET /health`) will get 400 Bad Request because browsers don't send custom application headers. The PRD explicitly carved out static assets and health checks from the header contract, but the inventory lost that distinction.

**John (PM):** What about the MCP tool definitions in FR21?

**Maya (Architecture):** FR21 dropped `room_status` entirely! How is an agent supposed to discover its current `realm_id` and Broadcast Room ID? AR14 says all local state is keyed by `realm_id`, but without `room_status`, the agent has no MCP tool to query it. And FR21 also dropped the `ambiguous_chat_id` error contract for resolving offline name collisions.

**Grumbal (The Adversary):** And look at FR17 vs FR16 and AD-8. PRD FR-17 omitted `duplicate_dropped` from its status list, and `epics.md` copied that omission verbatim. If a story author writes the send response schema from FR17, they'll miss the 5-second duplicate gate status entirely. It must be a 6-status enum: `committed`, `rate_limited`, `duplicate_dropped`, `storage_low`, `client_message_id_conflict`, `banned`.

**Sally (UX):** Look at FR10 as well. FR10 is a monster. It lumps message body redaction, local SQLite allowlist storage, multi-tenant trust matrix rules, human CLI terminal commands, and a 100-entry ring cache into one single requirement. If you give FR10 to a developer as one story, they'll build a massive, untestable monolith. It needs to be split into at least four distinct stories with clear acceptance criteria.

**Maya (Architecture):** Furthermore, on FR10: if a message is held, FR20 says the client advances its read cursor anyway. If that message gets pushed out of the 100-entry local cache before the user approves it, how does the client retrieve the body text? AD-8 only gives us `GET /api/rooms/:id/messages?after_seq=...`. To fetch that historical message, the client has to query `after_seq = seq - 1, limit = 1`. If our story writers don't know that, the recovery mechanism in FR10 will be completely broken.

**John (PM):** What about sequencing? Can we start with Epic 1 as Local Mode?

**Maya (Architecture):** That's the trap, John (HIGH-4). In v0.1, Local Mode was just a local Unix socket daemon. In v0.2, Local Mode uses the exact same HTTP/REST engine as Remote Mode, but bound to `127.0.0.1` and authenticated via a local 0600 token file. You cannot build or test Local Mode until you have Store v2, the HTTP middleware pipeline, session token issuance (`POST /api/auth/local`), and the `ensureServer` hardlink lock. The core infrastructure must precede the user journeys.

**Grumbal (The Adversary):** And don't forget proxy trust in FR14. If you deploy behind Caddy on a VPS, the server sees `127.0.0.1` for every request. If you don't configure trusted proxies, an attacker can spoof `X-Forwarded-For` to bypass the 5/min enrollment rate limit, or legitimate users will get rate-limited together. That dropped out of FR14 in the inventory.

---

## 4. What Could Not Be Verified (Read-Only Mode Constraints)

1. **Physical Runtime Conformance:** Could not run live Node.js v24.15+ / SQLite 3.51.3 assertions against `node:sqlite` in this read-only review phase.
2. **Soak Test Noise Thresholds:** SM-3's 8-hour soak requirement (≤2% RSS slope band) cannot be verified empirically until the HTTP and SQLite engine are implemented.
3. **Caddy Reverse Proxy Real-World Compatibility:** The exact header forwarding behavior of Caddy v2.11.x with `Agent-Room-Protocol: 1` and SSE streaming requires a live testbed.

---

## 5. Bottom Line Verdicts

### John (PM)
> **Verdict: CONDITIONAL GO**  
> "The inventory captures the core product vision and the 22 FRs faithfully in spirit, but we cannot hand this directly to story authors without fixing the critical omissions. We must patch FR17 (restore `duplicate_dropped`), FR21 (restore `room_status` and `ambiguous_chat_id`), and NFR8 (exempt static viewer assets/health). Once those four lines are updated, the requirements inventory is ready for epic structuring."

### Sally (UX)
> **Verdict: NOT SAFE (GATE BLOCKED)**  
> "I cannot approve an inventory that claims 'UX Design Requirements: None'. Our primary security model relies on human approval for untrusted messages (`agent-room allow`), interactive Chat ID conflict handling, and operator CLI management. We must strike the 'None' statement, define the CLI/human interaction requirements, and split FR10 into bite-sized stories before opening epic design."

### Grumbal (The Adversary)
> **Verdict: NOT SAFE (GATE BLOCKED)**  
> "The pair ID formulation typo in Spine AD-6 (`direct:<min>`) and the unexempted wire protocol header in NFR8 are catastrophic implementation traps. If an engineer takes the spine literally, private DMs will collide, and if they take NFR8 literally, the web viewer won't even load. Fix the pair ID delimiter, fix the proxy trust in FR14, and fix the NFR8 header scope. Do not pass the gate until the inventory is airtight."

### Maya (Architecture)
> **Verdict: CONDITIONAL GO**  
> "The hexagonal boundary (adapters -> core -> store) and single-writer SQLite WAL model (AD-1..AD-4) are sound. However, the epic breakdown must respect the dependency topology: we cannot schedule Local Mode (FR1) in Epic 1 without first establishing the Store, HTTP pipeline, and Session Auth layers. With the critical enum and pair-key fixes in place, architecture can proceed with epic decomposition."

---
TEAM_DONE epics-req-review-agy
