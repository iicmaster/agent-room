# Review: complete story breakdown → agy-advisor

> Provenance: task `epics-stories-review-agy`, effective_identity `gemini-3.8-flash-high (matched)`, receipt-backed ACP dispatch (session fd14e0ce), completed 2026-09-20 09:11. Verbatim outbox capture. Verdicts: Epic 1 & 4 FIX-FIRST (CRIT-1 keypair sequencing, HIGH-1/2 cursor+disambiguation, MED-1 CLI inversion); Epics 2/3/5/6 SAFE.

# Complete Story Breakdown Review: Agent Room v0.2 (33 Stories, 6 Epics)

**Task ID:** `epics-stories-review-agy`  
**Review Target:** `/Users/ngs/agent-skills/plugins/agent-room/docs/epics.md`  
**Reviewers:** The Round-Table (John, Sally, Grumbal, Maya, Level)  
**Authority Sources:**
- PRD: `docs/prds/prd-agent-room-2026-09-20/prd.md` (FR-1..FR-22, NFR-1..NFR-8, Non-Goals, Metrics SM-1..SM-4, SM-C1..SM-C2)
- Architecture Spine: `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md` (AD-1..AD-14, Structural Seed, Capability Map)
- Addendum: `docs/prds/prd-agent-room-2026-09-20/addendum.md` (Decisions D1–D19, DR-1)
- Binding Epic Rulings: `docs/epics-review/ruling-structure-agy.md` (Decisions Q1–Q5)

---

## 1. Executive Summary & The Round-Table Cast

The builder delegated the final acceptance review of the complete 33-story, 6-epic breakdown in `docs/epics.md` to this round-table before development dispatch.

The overall architecture, sequence, and gating contracts established in the structural ruling (`ruling-structure-agy.md`) have been substantially and faithfully incorporated: the mid-Epic-1 checkpoint (1.8), blocking REL-2 continuity drill (2.5), migration idempotency (2.3), four-story FR-10 decomposition (3.1–3.4), integrated trust test (3.5), remote dress rehearsal (4.8), strict packaging gate from Epic 1 (1.9), and zero deferred QA in Epic 6 are all present with real anti-theater criteria.

However, a rigorous audit of the 33 stories against the architecture spine (AD-1..AD-14) and PRD contracts revealed **critical sequencing flaws and omitted client-side criteria in Epic 1 and Epic 4**. Specifically:
1. **Epic 1 requires real Actor fingerprints** (for `direct:<fp_min>:<fp_max>` Direct Rooms in 1.2, claims indexing in 1.5, presence in 1.6, untrusted framing in 1.7, and the 1.8 checkpoint), **yet Ed25519 keypair generation is deferred to Story 4.1 in Epic 4!**
2. **Client-side cursor persistence (`client/cursors.mjs`) and `outcome_unknown` retry handling** are specified in the inventory and coverage map (FR-20 / FR-17), but **completely omitted from Epic 1's story acceptance criteria.**
3. **HCI-4 (`ambiguous_chat_id` resolution)** returns candidate fingerprints in Story 1.7, but provides **zero mechanism or parameter in AD-8's vocabulary for the caller to actually select a candidate and open the room.**
4. **Operator CLI infrastructure is inverted in Epic 4:** Stories 4.2 and 4.5 test CLI verbs before Story 4.6 establishes the server-host CLI entrypoint.

### Verdict Summary
- **Epic 1:** **FIX-FIRST** (Keypair generation missing in 1.1/1.4; client cursors and `outcome_unknown` missing in 1.7; HCI-4 disambiguation dead-end; Story 1.7 overloaded)
- **Epic 2:** **SAFE** (Flawless alignment with REL-2, AR-4 migration, AR-10 reclaim, and endurance harness)
- **Epic 3:** **SAFE** (Faithful FR-10 4-story split, frozen-schema compliance, HCI-2 CLI, and 3.5 integrated test)
- **Epic 4:** **FIX-FIRST** (Operator CLI dependency inversion across 4.2/4.5/4.6; Story 4.1 scope needs narrowing to remote challenge-response)
- **Epic 5:** **SAFE** (Clean GET-only viewer, Bearer→cookie bridge, all 8 presence states, CSP inert rendering)
- **Epic 6:** **SAFE** (Strict anti-dumping compliance, zero deferred component QA; minor duplicate summary block in docs)

### The Round-Table Cast
- **John (Product Manager):** Guardian of MVP scope, user journeys (UJ-1..UJ-4), release metrics (SM-1..SM-4, SM-C1..SM-C2), and developer dispatch schedule.
- **Sally (UX & Ergonomics Lead):** Champion of CLI interactions (HCI-1..HCI-5), human-in-the-loop workflows, error ergonomics, and developer velocity.
- **Grumbal (The Adversary / Security & Failure Specialist):** Ruthless critic auditing untrusted boundaries, spoofing vectors, race conditions, wire protocol drift, and safety theater.
- **Maya (Systems Architecture Specialist):** Guardian of hexagonal isolation (AD-3), SQLite single-writer semantics (AD-2, AD-4), dependency acyclicity, and storage admission (FR-22).
- **Level (QA & Release Engineer):** Guardian of test adequacy, non-theater harnesses, independent testability of ACs, and packaging validity (`validate --strict`).

---

## 2. Severity-Ranked Findings

```
================================================================================
CRITICAL FINDINGS (Must fix before dispatching dev agents)
================================================================================
```

### [CRIT-1] Identity Keypair & Canonical Fingerprint Lifecycle Missing from Epic 1 (Stories 1.1, 1.2, 1.4 vs 4.1)
- **Stories Impacted:** Story 1.1, Story 1.2, Story 1.4, Story 1.5, Story 1.7, Story 1.8 vs Story 4.1
- **Requirements Binding:** FR-3, FR-7, FR-9, FR-19, AD-5, AD-6, Ruling Q5
- **The Defect:**
  In Epic 1:
  - Story 1.2 creates Direct Rooms keyed by `direct:<fp_min>:<fp_max>`, where `fp` is the Actor key fingerprint.
  - Story 1.5 updates `chat_id_claims` with `(chat_id, actor_fingerprint, last_seen_at)`.
  - Story 1.6 renders `Actor fingerprint` in presence.
  - Story 1.7 enforces the `<untrusted_message>` envelope whenever `sender_actor_fingerprint !== local_actor_fingerprint`.
  - Story 1.8 runs a real-process integration test asserting DM creation and envelope behavior between two distinct agents.
  **Yet nowhere in Epic 1 is the Ed25519 keypair created or loaded!**
  Keypair creation is explicitly assigned to **Story 4.1** ("As a remote session, I want Ed25519 proof-of-possession per connection... Given the installation keypair in PLUGIN_DATA...").
- **Consequence:** If a dev agent implements Epic 1 as written, they will either mock the actor fingerprint (e.g. using v0.1's random UUID or arbitrary strings) or fail to implement the pair keys in 1.2. When Story 4.1 lands in Epic 4 and introduces the real Ed25519 keypair and canonical SHA-256 fingerprint, **every Direct Room ID, claims index row, and test assertion written in Epics 1, 2, and 3 will break!**
- **Required Fix:**
  Move the local keypair initialization (`ensureIdentityKeypair()` in `server/runtime.mjs`) into **Story 1.1** (or Story 1.4). Story 1.1 or 1.4 must explicitly state: "Given a fresh `PLUGIN_DATA`, When initialized, Then an Ed25519 keypair is generated (0600) and its canonical SHA-256 fingerprint (over raw 32-byte public key) is computed."
  Narrow **Story 4.1** to focus strictly on remote challenge-response authentication (`/api/auth/challenge` and `/api/auth/answer` nonce signing).

---

```
================================================================================
HIGH FINDINGS (Design holes that will stall or break dev agents)
================================================================================
```

### [HIGH-1] Client-Side Cursors and `outcome_unknown` Retry Omitted from Story 1.7 ACs
- **Stories Impacted:** Story 1.7 (and Epic 1 Coverage Map)
- **Requirements Binding:** FR-17, FR-20, AR-4, AR-12, D16
- **The Defect:**
  The Requirements Inventory (line 63, line 66) and the FR Coverage Map (line 134) explicitly specify:
  `FR20: Epic 1 — Delivery contract: ack, cursors, outcome_unknown retry`
  However, in Story 1.7's Acceptance Criteria:
  1. There is **zero criterion** for persisting client-owned cursors in `PLUGIN_DATA/realms/<realm_id>/cursors.json` (`client/cursors.mjs`). Story 1.7 only states that `message_read` accepts `after_seq`. If the MCP adapter does not save the cursor per `(installation, realm, room)`, the agent has to manually track sequence numbers across sessions.
  2. There is **zero criterion** for client-side `outcome_unknown` handling. If a network timeout occurs during `message_send`, what does the client do? FR-17/FR-20 require that the client-side library treats a dropped connection / timeout as `outcome_unknown` and retries with the exact same `client_message_id`.
- **Consequence:** Dev agents building Story 1.7 will write a purely stateless passthrough MCP tool. In Epic 2, when kill-drills and reconnects happen, client sessions will lose track of where they were because client cursor persistence was never built into the client adapter.
- **Required Fix:**
  Add an explicit AC to Story 1.7:
  "**Given** a successful `message_read`, **When** messages return, **Then** the client advances and durably persists its cursor per `(installation, realm, room)` in `PLUGIN_DATA`; **Given** a network failure or timeout during `message_send`, **When** the outcome is unknown, **Then** the client marks status `outcome_unknown` and retries with the identical `client_message_id`, resolving via server idempotency."

### [HIGH-2] HCI-4 Disambiguation Flow is a Dead-End (Story 1.7 vs AD-8 Frozen Vocabulary)
- **Stories Impacted:** Story 1.7, Requirements Inventory HCI-4
- **Requirements Binding:** FR-21, HCI-4, AD-8, AD-6
- **The Defect:**
  Requirement HCI-4 states: "`ambiguous_chat_id` human resolution (FR21) — candidate fingerprints + last-seen presentation and disambiguation flow; never a silent guess."
  Story 1.7 states that `room_direct_open({chat_id})` returns `ambiguous_chat_id` with candidate fingerprints and last-seen timestamps when multiple Actors claim a name.
  **However, there is no way to complete the disambiguation!**
  Spine AD-8 defines the frozen request field vocabulary: `chat_id, client_message_id, text, reply_to_seq, after_seq, limit, wait_ms, include_offline, invite_token, public_key, nonce, signature, realm_id`.
  Notice that `target_fingerprint` or `actor_fingerprint` is NOT in the request vocabulary for `room_direct_open` or `POST /api/rooms/direct`!
  If an agent or human gets `ambiguous_chat_id`, how do they tell the server which Actor they want to open the room with?
- **Consequence:** The caller is completely stuck. They are shown the candidate fingerprints, but cannot open a room to any of them because the API and tool only accept `{chat_id}`.
- **Required Fix:**
  Explicitly specify in Story 1.7 (and verify against AD-8): `room_direct_open({chat_id, target_fingerprint?})`. If `target_fingerprint` is provided, it disambiguates directly to that candidate. Add an explicit test case in Story 1.7 demonstrating successful resolution following an `ambiguous_chat_id` response.

---

```
================================================================================
MEDIUM FINDINGS (Sequencing friction and scope bloat)
================================================================================
```

### [MED-1] Operator CLI Dependency Inversion and Conflation in Epic 4 (Stories 4.2, 4.5, 4.6)
- **Stories Impacted:** Story 4.2, Story 4.5, Story 4.6
- **Requirements Binding:** FR-14, FR-15, FR-22, AD-13, HCI-3
- **The Defect:**
  - Story 4.2 requires testing `Given operator invite mint/list/revoke, When run...` via the CLI.
  - Story 4.5 requires testing operator `ban` via the CLI.
  - Yet Story 4.6 is titled **"Operator CLI & storage admission control"** and introduces: "Given the CLI on the server host, When invoked (serve, invite mint/list/revoke, ban/unban, capacity), Then it calls core in process; no operator routes exist in the wire API..."
  How can a dev agent in Story 4.2 write end-to-end tests for CLI invite commands if the server-host CLI infrastructure is only designed in Story 4.6?
  Furthermore, Story 4.6 conflates two completely orthogonal systems: building the Operator CLI entrypoint (`cli/`) and implementing disk capacity monitoring/refusal (`storage_low`, FR-22).
- **Required Fix:**
  Reorder or clarify the CLI responsibility: Story 4.2 should establish the basic `cli/` host harness along with the `invite` commands. Story 4.5 implements the `ban/unban` command. Story 4.6 should be dedicated to **Storage admission control & capacity monitoring (FR-22)**, adding the `capacity` command to the already-existing CLI.

### [MED-2] Story 1.7 is Overloaded for a Single Dev Agent
- **Stories Impacted:** Story 1.7
- **Requirements Binding:** Sizing guideline (completable by ONE dev agent)
- **The Defect:**
  Story 1.7 requires a single dev agent to implement:
  1. Five distinct MCP tools (`room_presence`, `room_direct_open`, `message_send`, `message_read`, `room_status`).
  2. The HTTP API client communication layer.
  3. Disambiguation logic for `ambiguous_chat_id`.
  4. Response shaping for the static versioned `<untrusted_message>` XML envelope.
  5. The interactive human terminal prompt for first-run Chat ID selection (HCI-1).
  6. Collision-refusal retry interactive UX in the terminal.
  This spans client MCP stdio protocol, wire HTTP client, string transformation, and interactive TUI/CLI prompting.
- **Required Fix:**
  Clarify that the interactive first-run Chat ID prompt (HCI-1) uses a minimal fallback readline helper in `runtime.mjs` / `client/`, or ensure that prompt handling does not derail the core MCP tool implementation.

---

```
================================================================================
LOW FINDINGS (Editorial / Cleanliness)
================================================================================
```

### [LOW-1] Duplicate Epic 6 Section in Epic List Summary
- **Lines Impacted:** `docs/epics.md` lines 165–172
- **The Defect:**
  Lines 165–168 and lines 169–172 are duplicate copies of the summary for "Epic 6: Prove It & Ship — integrated proof, nothing deferred".
- **Required Fix:** Delete the redundant second copy (lines 169–172).

---

## 3. Comprehensive Checklist Audit

### 3.1 Template Compliance
- **Rule:** Every story must have `As a / I want / So that` + `Given / When / Then` ACs that are independently testable.
- **Audit Result:** **100% COMPLIANT (33 of 33 stories).**
  - All 33 stories strictly adhere to the user story persona structure (`As a`, `As an`, or `As the`).
  - Every story has explicit, capitalized `**Given**... **When**... **Then**...` statements.
  - Acceptance criteria are specific, citing bounded numbers, error codes, and assertions rather than vague aspirations.

### 3.2 Sizing & Dependency Order
- **Rule:** Each story completable by ONE dev agent; no forward dependencies within an epic; tables/entities created only when needed.
- **Audit Result:** **CONDITIONAL PASS (Fails on MED-1 & MED-2).**
  - **Epic 1:** Stories 1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6 → 1.7 → 1.8 → 1.9 form an excellent logical sequence, except for the CRIT-1 gap (keypair generation deferred to 4.1) and Story 1.7 sizing bloat.
  - **Epic 2:** Clean sequence 2.1 (restart) → 2.2 (reconnect) → 2.3 (migration) → 2.4 (churn) → 2.5 (drill).
  - **Epic 3:** Clean sequence 3.1 (labeling) → 3.2 (allowlist) → 3.3 (held cache) → 3.4 (CLI) → 3.5 (integration test).
  - **Epic 4:** Dependency inversion between 4.2/4.5 (CLI usage) and 4.6 (CLI host creation) needs resolution (MED-1).
  - **Epic 5 & 6:** Minimal, tightly scoped stories.

### 3.3 Coverage Completeness Matrix
All 22 FRs, 17 ARs, 5 HCIs, 5 RELs, and 8 NFRs were audited across the 33 stories:

| Requirement | Primary Story | Real vs Nominal AC | Verdict & Notes |
|:---|:---|:---|:---|
| **FR-1** (Local Mode) | 1.1, 1.4 | Real | Loopback bind, auto-token issuance, shared dir convergence |
| **FR-2** (Remote Mode) | 4.3 | Real | HTTPS required, cert verification, persistent config |
| **FR-3** (Identity Key & Enrollment) | 4.1, 4.2 | **Defective** | Enforces challenge & secret hygiene, but keypair generation missing from Epic 1 (CRIT-1) |
| **FR-4** (Self-Hostable Server) | 1.3, 4.7 | Real | Caddy + native HTTPS guide, zero npm deps, health checks |
| **FR-5** (Presence List) | 1.6 | Real | TTL 180s, jitter, 24h offline bucket, claims index backing |
| **FR-6** (Broadcast Room) | 1.2, 1.3 | Real | Implicit membership, 32 KiB text cap, idempotency tuple |
| **FR-7** (Direct Rooms - Primary) | 1.2, 1.7 | Real | `direct:<fp_min>:<fp_max>`, same-actor pairs, ACL privacy |
| **FR-8** (Long-Poll Cursor Reads) | 1.7 | Real | `after_seq` strictly greater, ≤20s hold, ≤200 page, deadline normal page |
| **FR-9** (Untrusted Marking) | 1.7, 3.1 | Real | Basic envelope in 1.7 (frozen schema); full versioned labeling in 3.1 |
| **FR-10** (Held Messages) | 3.1..3.4 | Real | Fully decomposed across 4 stories per inventory note |
| **FR-11** (Ordinary Restart) | 2.1 | Real | Kill -9 safe, WAL+FULL, sequences contiguous, cursors valid |
| **FR-12** (Session Reconnect) | 2.2 | Real | No re-enrollment, room discovery, bounded catch-up, backoff 1-60s |
| **FR-13** (Endurance Basis) | 2.4, 6.2 | Real | Churn test + leak-tracker harness in 2.4; formal 8h soak in 6.2 |
| **FR-14** (Invite Lifecycle) | 4.2 | Real | `ar_inv1_`, atomic single-transaction, 5/min/IP burst 5, secret redaction |
| **FR-15** (Ban by Key) | 4.5 | Real | Next-request refusal, active long-poll bounded by 20s window |
| **FR-16** (Four Rate Gates) | 4.4 | Real | Idempotency first, token bucket (0.5/s), budget (120/min), 5s duplicate gate |
| **FR-17** (Sender Notices) | 1.7, 4.4 | **Defective** | Six statuses covered, but client-side `outcome_unknown` missing in 1.7 (HIGH-1) |
| **FR-18** (Read-Only Viewer) | 5.1, 5.2 | Real | GET-only, cookie bridge, CSP inert rendering, 8 presence states, DMs excluded |
| **FR-19** (Chat ID & Rename) | 1.5 | Real | DR-1 format (1-32 chars, case-insensitive), collision refusal, send-time attribution |
| **FR-20** (Delivery Contract) | 1.2, 3.5 | **Defective** | Store commit & retry covered; client cursor persistence missing in 1.7 (HIGH-1) |
| **FR-21** (MCP Tool Surface) | 1.7 | **Defective** | Tools exist, but HCI-4 disambiguation lacks parameter to complete (HIGH-2) |
| **FR-22** (Storage Admission) | 4.6 | Real | Warn <1 GiB, refuse <256 MiB (`storage_low`), backup guide |
| **HCI-1** (First-Run Prompt) | 1.7 | Real | Chat ID selection prompt with collision-refusal retry |
| **HCI-2** (Held Human Flow) | 3.4 | Real | `held list`, `held show` (only body preview), `allow`, `--remove` |
| **HCI-3** (Operator CLI) | 4.2, 4.5, 4.6 | Real | Invites, bans, capacity status; in-process host execution |
| **HCI-4** (Disambiguation) | 1.7 | **Nominal** | Returns candidate fingerprints, but caller cannot select one (HIGH-2) |
| **HCI-5** (Viewer Auth Bridge) | 5.1 | Real | `GET /viewer/auth` Bearer→cookie, no query-string tokens |
| **REL-1** (Cross-Everything) | 6.1 | Real | Two physical machines, two vendors (Claude Code + Zcode), live DM + broadcast |
| **REL-2** (Continuity Drill) | 2.5 | Real | **Blocking gate:** external recorder, ≥3 kill -9 cycles under write traffic |
| **REL-3** (8-Hour Soak) | 6.2 | Real | Single memory pass rule (RSS slope ≤2%), 32 KiB payloads, hourly reconnects |
| **REL-4** (Idle Footprint) | 6.2 | Real | 0–5 Actors baseline recorded, counter-metric to REL-1 |
| **REL-5** (Usage Journal) | Pre-Epic | Real | Explicitly documented as post-release, not a story AC |

### 3.4 AC Quality & Specific Edge Conditions
- **Collision Refusal (FR-19):** **PASSED.** Explicit error, no suffixing (Story 1.5, Story 1.7).
- **Ambiguous Chat ID (FR-21):** **PARTIAL.** Detection and candidate list passed (1.7); resolution flow missing parameter (HIGH-2).
- **Outcome Unknown Retry (FR-17/20):** **FAILED.** Not covered in client-side ACs (HIGH-1).
- **Storage Low (FR-22):** **PASSED.** Warn <1 GiB, refuse appends <256 MiB (Story 4.6).
- **Ban Latency Bound (FR-15):** **PASSED.** In-flight long-polls bounded by 20s hold window (Story 4.5).
- **Cookie-Not-Query-String (FR-18):** **PASSED.** HttpOnly SameSite=Strict cookie via `/viewer/auth` Bearer exchange (Story 5.1).
- **Inert Rendering (FR-18):** **PASSED.** CSP + inert rendering, no script execution (Story 5.2).
- **Plaintext Refused (FR-2):** **PASSED.** HTTPS required off-loopback with certificate/hostname verification (Story 4.3).

### 3.5 Negative Constraints & Non-Goals Audit
- No task delegation / orchestration logic added (Complies with SAM/A2A boundary).
- No server federation or relaying introduced.
- No push notification or background wake mechanisms (MCP remains strict pull).
- No message editing or deletion verbs (Logs are strictly append-only, `keep-all`).
- Plaintext at rest preserved; no E2E encryption theater.
- Exactly one Broadcast Room + Direct Rooms per server (no channels or hierarchies).
- Direct Rooms are strictly primary surface and built first in Story 1.2 (Complies with D14 DM-first).

---

## 4. Per-Epic Verdicts

### Epic 1: First Conversation — **FIX-FIRST**
- **Blockers:**
  1. [CRIT-1] Must move Ed25519 keypair generation and canonical SHA-256 fingerprint derivation into Story 1.1 or 1.4.
  2. [HIGH-1] Must add client cursor persistence and `outcome_unknown` retry ACs to Story 1.7.
  3. [HIGH-2] Must provide the disambiguation parameter (e.g. `target_fingerprint`) for HCI-4 in Story 1.7.
  4. [MED-2] Must safeguard Story 1.7 against dev agent overload.

### Epic 2: Nothing Is Lost — **SAFE**
- **Assessment:** Exemplary epic design. Story 2.1 (ordinary restart) correctly distinguishes itself from Story 2.3 (v1→v2 migration with cursor reset). Story 2.4 builds the leak tracker, and Story 2.5 enforces the blocking REL-2 drill with an external recorder under live kill -9 cycles. Fully adheres to ruling Q1 and Q4.

### Epic 3: Safe to Talk to Strangers — **SAFE**
- **Assessment:** Flawlessly adheres to ruling Q5 and the inventory note. Decomposes FR-10 across 4 dedicated stories (3.1 labeling, 3.2 allowlist, 3.3 held cache with point-read recovery, 3.4 human CLI). Story 3.5 ties FR-10, FR-20, and AR-12 into a single cohesive end-to-end integration test.

### Epic 4: The Wider Room — **FIX-FIRST**
- **Blockers:**
  1. [MED-1] Resolve dependency inversion: establish the server-host CLI infrastructure in 4.2 before testing `invite` commands, rather than deferring the CLI host to 4.6.
  2. [CRIT-1] Narrow Story 4.1 to remote challenge-response signing, consuming the keypair established in Epic 1.

### Epic 5: Watch from Outside — **SAFE**
- **Assessment:** Tightly scoped and strictly compliant with ruling Q2 (positioned at slot 5). DMs are explicitly excluded; the Bearer→cookie bridge avoids query-string tokens; all 8 presence states from Epics 2 and 4 are rendered inert under CSP.

### Epic 6: Prove It & Ship — **SAFE**
- **Assessment:** Strict anti-dumping compliance (ruling Q4). Contains zero deferred component QA. Focuses entirely on physical multi-machine demonstration (REL-1), formal 8-hour soak (REL-3), and dual-package smoke tests. (Requires deletion of the duplicate summary block [LOW-1]).

---

## 5. Round-Table Discussion (Bmad Party Mode)

**Grumbal (The Adversary):**  
"I am sounding the emergency siren on Epic 1. Look at Story 1.2: Maya specifies Direct Room keys as `direct:<fp_min>:<fp_max>`. Look at Story 1.7: foreign messages get wrapped in `<untrusted_message>` if `sender_fingerprint !== local_fingerprint`. Look at Story 1.8: Level demands two real child processes DMing each other with zero mocks. Now look at Story 4.1! Story 4.1 is titled *'Identity keypair & challenge authentication'*. Where does the keypair come from in Epic 1?! It doesn't exist! If you give Story 1.1 to a dev agent today, the agent will see no keypair requirement, generate some placeholder UUID, and write Epic 1 around fake fingerprints. When Epic 4 lands, every single Direct Room and claims record in the database is invalidated. That is an amateur sequencing bug."

**Maya (Systems Architecture):**  
"Grumbal is completely right on the consequence, though it was clearly an editorial oversight in the Capability Map rather than intent. Architecture Spine AD-5 is unequivocal: `Each installation holds one Ed25519 keypair, stored beside identity.json in PLUGIN_DATA; the Actor's fingerprint is SHA-256 over the raw 32-byte public key (canonical, forever).' Local Mode uses the exact same keypair to establish Actor identity; it just bypasses the remote challenge-response via `/api/auth/local`. The fix is trivial but mandatory: move `ensureIdentityKeypair()` into Story 1.1 or 1.4. Story 4.1 must only implement the remote `/api/auth/challenge` and `/api/auth/answer` routes."

**Sally (UX & Ergonomics):**  
"And while we're stopping Epic 1 from going to development, look at what they did to HCI-4! Story 1.7 proudly claims: `room_direct_open({chat_id})` returns `ambiguous_chat_id` with candidate fingerprints and last-seen timestamps when an offline name has multiple claimants. Great! The user sees two fingerprints. Now what does the user do? Look at the tool arguments in 1.7 and the frozen vocabulary in AD-8: there is NO argument for fingerprint! The user is handed two keys and locked in the hallway because the door has no keyhole. If `room_direct_open` doesn't accept `{chat_id, target_fingerprint}`, HCI-4 is pure theater."

**John (Product Manager):**  
"Hold on, Sally. If `room_direct_open` takes `chat_id`, the normal flow is addressing an online agent or a known offline peer. How often does an offline Chat ID collide?"

**Sally (UX):**  
"It doesn't matter how often it happens, John! The PRD created the `ambiguous_chat_id` error code specifically for this edge case. If you define the error code, you must define the recovery path. Otherwise, an agent or human hitting that error has no way to proceed other than waiting for the peer to come online."

**Level (QA & Release):**  
"I have an even bigger problem with Story 1.7: where is client cursor persistence? The coverage map says FR-20 lives in Epic 1. But Story 1.7 only specifies that `message_read` accepts `after_seq`. It doesn't require the MCP client to save the returned `next_after_seq` into `PLUGIN_DATA/realms/<realm_id>/cursors.json`! If the client doesn't persist cursors, what happens in Epic 2 when the server restarts? The agent starts reading from sequence 0 again! And what about `outcome_unknown`? When a network socket drops mid-send, the client must tag the send `outcome_unknown` and retry with the exact same `client_message_id`. If Story 1.7 doesn't specify that, the dev agent won't build the retry logic."

**Maya (Systems Architecture):**  
"Level's point is vital. The client-side delivery contract in AD-4 and D16 relies on the client owning its cursors and driving idempotent retries. The server holds zero delivery state. If Story 1.7 doesn't build `client/cursors.mjs`, Epic 1 is not a working client."

**John (Product Manager):**  
"Can a single dev agent even build all of Story 1.7 if we add cursors and `outcome_unknown`? Look at what is already in 1.7: five MCP tools, untrusted envelope formatting, disambiguation, AND the interactive first-run terminal prompt (HCI-1). That story is already bursting at the seams."

**Sally (UX):**  
"I agree with John on Story 1.7 sizing. Story 1.7 is doing too much. Building the MCP protocol server and formatting the XML envelope is one job. Writing an interactive terminal prompt for Chat ID selection with collision retries (HCI-1) is a completely different job. At minimum, 1.7 should delegate HCI-1 to a clean utility function in `runtime.mjs` so the agent doesn't get lost in readline callbacks."

**Grumbal (The Adversary):**  
"Now look at Epic 4. In Story 4.2, the acceptance criteria say: `Given operator invite mint/list/revoke, When run, Then the raw token is shown once...` That's a CLI command. In Story 4.5: `Given a banned fingerprint...` operator bans via CLI. Then in Story 4.6, the epic author suddenly remembers to write: `Story 4.6: Operator CLI & storage admission control... Given the CLI on the server host, When invoked... Then it calls core in process; no operator routes exist in the wire API.` Why is the CLI host being built AFTER the CLI commands? And why is the Operator CLI bundled into the same story as storage admission control (FR-22)? Those have nothing to do with each other!"

**Level (QA & Release):**  
"Grumbal is right. Story 4.6 is a franken-story. It has disk capacity warnings (`storage_low`, 1 GiB/256 MiB thresholds) glued to the Operator CLI host entrypoint. Move the CLI host into 4.2 so 4.2 can implement `invite`, 4.5 implements `ban`, and 4.6 becomes purely Storage Admission Control."

**John (Product Manager):**  
"Let's look at the big picture, team. Epics 2, 3, 5, and 6 are rock solid. Epic 2 has the blocking kill -9 drill. Epic 3 decomposes FR-10 properly and freezes the envelope. Epic 5 keeps the viewer strictly GET-only. Epic 6 has zero deferred QA. We don't need a total rewrite. We need surgical fixes to the acceptance criteria of Epic 1 (Stories 1.1, 1.7) and Epic 4 (Stories 4.1, 4.2, 4.6). Once those four stories are patched, the breakdown is ready for dev."

---

## 6. Each Voice's Bottom Line

- **Grumbal (The Adversary):**  
  **"NOT SAFE TO HAND TO DEV AGENTS."**  
  *Bottom line:* Epic 1 has an existential identity flaw. If an agent implements Story 1.2 and 1.7 without a real Ed25519 keypair, the entire Direct Room addressing scheme is built on sand. Fix CRIT-1, add `outcome_unknown` retry to 1.7, and untangle the Epic 4 CLI inversion before letting any dev agent write a line of code.

- **Level (QA & Release Engineer):**  
  **"NOT SAFE TO HAND TO DEV AGENTS."**  
  *Bottom line:* Story 1.7 is a trap. It is overloaded with five tools and TUI prompting, while omitting the two most critical testable contracts in FR-20: client cursor persistence and `outcome_unknown` retries. Dev agents will declare 1.7 done with an in-memory mock and leave Epic 2 stranded. Patch the ACs first.

- **Maya (Systems Architecture Specialist):**  
  **"NOT SAFE TO HAND TO DEV AGENTS."**  
  *Bottom line:* The hexagonal boundary and SQLite store designs are sound, but the dependency graph is inverted in two places: keypair generation belongs in Epic 1 (Story 1.1/1.4), not Story 4.1; and the Operator CLI entrypoint belongs in Story 4.2, not Story 4.6. Realign those contracts, and the system will compile cleanly.

- **Sally (UX & Developer Ergonomics Lead):**  
  **"NOT SAFE TO HAND TO DEV AGENTS."**  
  *Bottom line:* HCI-4 is an unresolved dead-end in Story 1.7 that will confuse any agent that encounters an offline name collision. Furthermore, stuffing the interactive first-run prompt into the MCP stdio story creates unnecessary cognitive overload for the implementer. Define the disambiguation parameter and isolate the prompt helper.

- **John (Product Manager):**  
  **"FIX-FIRST, THEN DISPATCH IMMEDIATELY."**  
  *Bottom line:* The structural rulings (Q1–Q5) and release-proof milestones are brilliantly executed. We are 90% of the way to a production-grade epic breakdown. Do not let dev agents stumble over predictable identity and cursor gaps: spend the two hours needed to patch Stories 1.1, 1.7, 4.1, 4.2, and 4.6, and then pull the trigger.

---

## 7. Plain Statement of What Could Not Be Empirically Verified

In accordance with strict verification standards, the following items cannot be empirically verified at this review gate and must be proven by runtime tests during execution:
1. **Interactive TUI Behavior in MCP Stdio Subprocesses (HCI-1):** How Claude Code and other client harnesses behave when `mcp-stdio.mjs` attempts an interactive terminal prompt (stdin/stdout readline) during MCP initialization could not be verified without live harness testing.
2. **Exact Node.js v24.15 `node:sqlite` Crash Recovery under SIGKILL:** While WAL + `synchronous=FULL` is SQLite standard, operating-system-specific filesystem cache flushing behaviors during `kill -9` drills (Story 2.5) can only be validated on the physical target OS.
3. **Caddy Reverse-Proxy SSE Keep-Alive Buffering:** Whether Caddy v2.11.x buffers SSE keep-alive comments (≤30s) under default proxy configurations without explicit `X-Accel-Buffering: no` or flush headers can only be verified against live network traffic in Story 4.7.

---
TEAM_DONE epics-stories-review-agy
