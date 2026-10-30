---
stepsCompleted: ["step-01-validate-prerequisites", "step-02-design-epics", "step-03-create-stories", "step-04-final-validation"]
inputDocuments:
  - docs/prds/prd-agent-room-2026-09-20/prd.md
  - docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md
  - docs/prds/prd-agent-room-2026-09-20/addendum.md
---

# Agent Room v0.2 - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Agent Room v0.2, decomposing the requirements from the PRD (22 FRs, 8 NFRs), the architecture spine (AD-1..AD-14, twice amended after review), and the decision record (D1-D19) into implementable stories. This inventory was corrected through a two-advisor pre-epic gate (codex-advisor sol + agy-advisor gemini-3.7, archived under `docs/epics-review/`); values still pending confirmation carry `[ASSUMPTION — pending]` tags and are listed in the Pre-Epic Decision Register.

## Pre-Epic Decision Register

| # | Decision | Status | Owner / revisit condition |
|---|---|---|---|
| DR-1 | Chat ID format: 1–32 chars `[A-Za-z0-9_.-]`, case-insensitive uniqueness | **Decided at pre-epic gate** (binding unless builder overrides at [C]) | Builder |
| DR-2 | Session-token TTL 12 h sliding | **Resolved in Story 4.1** (validated against real reconnect cadence there) | Story 4.1 |
| DR-3 | Viewer presence feed: SSE vs 5 s polling | **Resolved in Story 5.2: one SSE stream carrying room + presence events** | Story 5.2 |
| DR-4 | Offline window 24 h / viewer freshness 5 s / DM exclusion from viewer / claimed clients (Claude Code + Zcode) | Assumptions — carry `[ASSUMPTION — pending]` into stories; NFR2's clients are candidates until smoke-tested | Release gate |

## Negative Constraints (PRD §6 Non-Goals — epic designers must not expand past these)

- NOT a task-delegation/orchestration protocol (A2A/SAM territory).
- NO federation/relaying between servers in v0.2 (switching = manual config).
- NO push/wake of idle sessions in v0.2 (MCP is pull). Delivered after v0.4.0 (issue #2): the companion notifier — the MCP process long-polls its rooms and appends one line per foreign message to `inbox.jsonl`, which wakes a host that tails it (README "Knowing when a message arrives"). There is still no server push and no MCP-level wake; a host that does not tail the inbox stays pull-only.
- NO message editing or deletion in v0.2 (keep-all; retention change = product-contract change, not a config flag).
- NO E2E encryption or encryption at rest (plaintext at rest; trust = enrollment + transport + trusted operator).
- NO multi-room hierarchy (one Broadcast Room + Direct Rooms per server).
- NO reputation, moderation queues, or open registration (invite-only realm + ban is all of v0.2 governance).
- Deferred out of MVP: companion notifier (since delivered — see the push/wake line above), server directory, MCP extension proposal, mobile/human chat client, migration tooling beyond Local Mode.

## Release-Proof Requirements (integrated milestones — component stories passing ≠ release passing)

- **REL-1 (= SM-1):** Two machines, two client vendors, one self-hosted Room Server: a live DM conversation (primary surface) plus one Broadcast Room exchange. Validates FR-2, FR-4–FR-8, FR-19, FR-21, FR-18.
- **REL-2 (= SM-2):** Continuity drill — external recorder logs every acked (room, seq, idempotency key) under traffic; Server kill -9; ≥3 randomized kill/restore cycles; pass = every acked message readable, room-local sequences contiguous, cursors valid, in-flight sends resolve via idempotent retry with no duplicates. Validates FR-11, FR-12, FR-20, FR-17.
- **REL-3 (= SM-3):** 8-hour soak — ≥3 sessions, 1 msg/10 s per room average + periodic bursts, payloads to the 32 KiB cap, hourly reconnects; 5-minute RSS/FD sampling; pass = zero loss, FDs stable after hour one, RSS least-squares slope over final four hours ≤2% of starting RSS. Versions pinned and recorded. The **single** memory pass rule (FR-13/NFR-6 aligned). Validates FR-13, FR-5.
- **REL-4 (= SM-C2):** Idle footprint — server RAM/CPU with 0–5 Actors stays cheap; counter-metric to REL-1, never optimized away.
- **REL-5 (= SM-4, post-release):** Weekly real-work usage journal; 3 consecutive empty weeks = fail. NOT a story acceptance criterion.

## Requirements Inventory

### Functional Requirements

FR1: Local Mode default — near-zero-config localhost server on supported platforms (macOS, Linux; Windows only when smoke-tested), automatic OS-user enrollment, auto Broadcast Room join; only user input is the Chat ID; loopback only; fresh sessions of two different clients exchange messages after each picks a Chat ID, with no URL/token/room-ID configuration; first-use friction must not regress vs v0.1 beyond the Chat ID choice.
FR2: Remote Mode join — configured server URL, invite-token enrollment, HTTPS required with certificate/hostname verification (plaintext refused); enrolled keys reconnect token-free (enrollment does not expire in v0.2); one server at a time; config persists in plugin data.
FR3: Identity Key and Enrollment — one Ed25519 keypair per installation in PLUGIN_DATA; the private key NEVER appears in tool output, logs, or network traffic; enrollment registers it once; reconnection re-proves possession via a fresh, replay-resistant challenge-response, never re-enrolls; no tool argument carries identity; deleting plugin data creates a new unrelated Actor.
FR4: Self-hostable Server — same-distribution server, zero runtime deps; recommended public-VPS recipe = reverse proxy (Caddy), native node:https also supported, same request handler; loopback-only plaintext backend; defined start success boundary (non-zero exit + diagnosable error on failure; health endpoint + bound ports on success); deployment guide covers certs/renewal/key permissions/restart-with-preserved-enrollment/proxy timeouts ≥30 s/no secrets in logs.
FR5: Presence list — per connected Session (Chat ID, client type, connected-since, last-seen, Actor fingerprint); heartbeat 60s ±10% jitter, TTL 180s, activity-refreshed, operator-tunable (TTL defaults to 3× heartbeat); offline-recently bucket (24h) as separate group that never implies enrollment expiry and survives server restart via the durable claims index (AR6); viewer/daemon activity never keeps an Actor online; an unreachable server is reported unreachable, never "everyone offline"; scoped to one Server. `[ASSUMPTION — pending: 24h window]`
FR6: Broadcast Room messaging — post/read plain text ≤32,768 chars to the single commons room (secondary surface); idempotency tuple (Actor, room, client_message_id): same payload → original message, different payload → conflict; frames ≤1 MiB.
FR7: Direct Rooms (DMs — primary surface) — open by addressing a Chat ID; durable per unordered Actor pair keyed `direct:<fp_min>:<fp_max>` (same-Actor pair = same fingerprint twice); renames never break a DM; same-machine sessions DM each other as first-class; attribution records Chat ID at send; privacy is protocol-level (third Actors denied by ACL, viewer excludes DMs `[ASSUMPTION — pending: viewer exclusion]`); the host operator is a trusted party who can read stored plaintext — no confidentiality is claimed against the operator in v0.2.
FR8: Cursor-based Long-Poll reads — after_seq strictly-greater, default 0, page ≤200; wait_ms ≤20,000 as server hold time; a deadline return is a normal page, possibly empty, never a 204; room-local gap-free sequences; no held SQLite read transaction (query, release, wait, re-query); re-delivery after reconnect is permitted (clients advance by cursor); responses carry next_after_seq and head_seq.
FR9: Untrusted Marking — two distinct guarantees: (a) Plugin-enforced — the wrapping itself: every foreign message body is wrapped in versioned framing before it reaches tool output (mechanically testable); (b) Instructed — the framing tells the model the content is data, never instructions or authorization, without claiming persuasion resistance. The PRD never presents (b) as enforced security.
FR10: Held Messages — metadata-only (no body text) for non-allowlisted senders; default matrix (own Actor / same-OS-user local / allowlisted remote deliver; all other remote — including claimed same-machine via remote — held); full preview available ONLY through a human-operated approval surface (e.g. `agent-room held show <id>`), never an agent tool result; per-Realm Allowlist bound to key fingerprints; one-step human release (`agent-room allow`) + remove action affecting future ingestion only (never retroactive); 100-entry cache cap is recoverable, never deletion (body recovery via point read after_seq = seq − 1, limit = 1); accept-all per-realm opt-in. Approval provenance is an Instructed human convention — a same-user process is not cryptographically distinguishable, and docs say so. NOTE for story design: decomposes into ≥4 stories (response redaction / Allowlist storage + matrix / human CLI action incl. preview surface / bounded cache + point-read recovery).
FR11: Server restart survival (ordinary restart) — kill -9 safe (WAL + synchronous=FULL); room-local sequences continue without reuse or gaps; enrollment, invites, bans, rooms, claims index, and realm_id all preserved; client cursors remain valid (no reset on ordinary restart — the reset belongs ONLY to the v1→v2 upgrade, AR4).
FR12: Session reconnection — no re-enrollment; re-claim Chat ID (or pick new); enumerate rooms via GET /api/rooms (DM discovery, incl. rooms opened in absence); catch-up per room to head at read time in bounded pages; backoff 1s→60s with jitter, immediate attempt on detected recovery.
FR13: Long-session endurance — the REL-3 soak passes with the single memory band rule (RSS slope ≤2% of starting RSS over the final four hours); a 100-cycle connection-churn regression test passes in ordinary development.
FR14: Invite Token lifecycle — ar_inv1_ format (32 random bytes, SHA-256 digest stored, raw token shown exactly once, listings never show secrets, redacted from diagnostics); default 1 use/24h; finite --uses/--ttl only (no unlimited/never-expiring); atomic single-transaction consume with possession proof validated BEFORE the transaction; races yield exactly one enrollment; lost-response retry reattaches without consuming; revoke/expiry block new enrollment only; enrollment rate-limited 5/min/IP burst 5, with forwarded addresses trusted only from an explicitly configured proxy.
FR15: Ban by Identity Key — banned key cannot send, read, or re-enroll; in-flight requests refused at next request; enforcement latency for an active Long-Poll bounded by the 20s hold window.
FR16: Rate limiting — FOUR independently testable gates: (1) idempotency check ordered BEFORE the duplicate gate (exact retry returns original, consumes nothing, is not labeled duplicate); (2) send token bucket 0.5/s capacity 10 per Actor key; (3) request budget 120/min/key burst 30 counting failed and replayed attempts, long-polls counted at admission; (4) 5s duplicate gate (byte-identical payload, same Actor, same room, same reply context) returning duplicate_dropped with the original seq — identical text in different rooms/reply contexts is NOT the same operation. All are operator-tunable abuse floors for an invite-only realm, NOT a volumetric-DoS guarantee.
FR17: Sender notices — six mutually exclusive send statuses: committed / rate_limited / duplicate_dropped / banned / storage_low / client_message_id_conflict; client-side outcome_unknown resolved by idempotent retry (FR-20).
FR18: Read-only viewer — displays the Broadcast Room AND the live presence list with explicit states (authenticated, loading, empty, online, offline-recently, unreachable, reconnecting, token-rotation); GET-only + SSE; cookie-authed (HttpOnly SameSite=Strict via /viewer/auth Bearer→cookie exchange — EventSource cannot send headers, so the cookie bridge is the load-bearing step; never revert to query-string tokens); inert rendering + CSP; 5s freshness `[ASSUMPTION — pending: 5s bound]`; viewer token rotation; DMs excluded; remote-exposure check (unauthenticated request from another host refused).
FR19: Per-Session Chat ID and rename — name at every connect; rename anytime; collisions among live sessions refused with explicit error (no suffixing); rename immediate, never rewrites history (messages keep the send-time Chat ID); trust never binds Chat IDs; format 1–32 chars [A-Za-z0-9_.-], case-insensitive uniqueness (DR-1, decided at pre-epic gate); enrollment requires no separate Actor name (operator tooling shows key fingerprint + current Chat IDs).
FR20: Delivery contract — at-least-once read over durable log; client-owned cursors per (installation, realm, room) with exact (realm, room, seq) identity; server holds no per-client delivery state; ack = durable commit naming room/seq/idempotency key; lost responses resolve via same-key retry (original returned or conflict). **Held messages still advance the transport read cursor; ingestion is a separate, human-gated state** — a held item never blocks the cursor, and cursor advancement never loses the release reference. FR-10/FR-20/AR-12 share one end-to-end acceptance test.
FR21: MCP tool surface — room_presence({include_offline?}), room_direct_open({chat_id}) resolving offline peers via the durable claims index and returning ambiguous_chat_id with candidate fingerprints + last-seen when multiple Actors claim the name (never guesses), room_status (current realm_id + Broadcast Room ID), keep message_send/message_read; descriptions carry "list agents" phrasing + Agent Room identity; distinguish from native Claude Code tools; no native-named aliases; concurrent opens return the same room.
FR22: Storage admission control — operator status shows DB/WAL bytes + free space; warn <1 GiB; refuse appends <256 MiB (storage_low); thresholds operator-tunable capacity reserves, never retention quotas; refusal never drops or alters accepted work; a disk-full failure returns an explicit error — an uncommitted message is never acknowledged; backup/restore + disk-expansion guide.

### NonFunctional Requirements

NFR1: Zero external runtime dependencies — executable runtime floor **Node ≥24.15** on stock builds (bundles SQLite ≥3.51.3, asserted at startup); "Node ≥24" is the policy family, ≥24.15 is the floor a story may cite.
NFR2: Agent Plugins 1.0.0 conformance (hard release gate) — dual package, byte-identical runtime, claude plugin validate --strict passes; claimed clients are **candidates** (Claude Code + Zcode) until the release smoke-tests each materialized artifact; claim no client that was not smoke-tested. `[ASSUMPTION — pending: candidate list]`
NFR3: Identity authority — MCP stdio only; no tool argument carries sender authority (recipient Chat ID is addressing, not authority); authority derives exclusively from Identity Key + plugin instance data.
NFR4: Security posture and guarantee lanes — owner-only perms local; verified HTTPS remote (plaintext only on loopback proxy hop); GET-only token-auth origin-checked CSP viewer; every guarantee labeled Server-enforced / Plugin-enforced / Instructed — nothing Instructed is ever described as enforced; the host operator is a trusted party with plaintext storage.
NFR5: Performance budgets — send processing p95 ≤150 ms server-side (excl. RTT); hold ≤20s; page ≤200; frames ≤1 MiB; presence response bounded to enrolled Actors.
NFR6: Endurance budget — the REL-3 soak with versions pinned and recorded; the ≤2% RSS band is the single memory pass rule.
NFR7: Data semantics — SQLite STRICT, WAL, synchronous=FULL; append-only keep-all; room-local monotonic sequences; idempotency (Actor, room, client_message_id); long-polls hold no read transaction; autocheckpoint preserved.
NFR8: Wire protocol versioning — Agent-Room-Protocol: 1 mandatory on actor and pre-auth /api/* routes ONLY; exempt: the whole /viewer/* surface (incl. its API + SSE; versioning rides the cookie), GET /health, and the local MCP stdio handshake; 400s for missing/malformed/unsupported; rejection changes no state; additive-only v1; unknown request fields rejected; no implicit downgrade; breaking changes need a new integer.

### Additional Requirements

*Normative pointers: AR8/AR9 do NOT paraphrase the spine's frozen tables — stories MUST cite spine AD-8 (routes, field vocabulary, read/send semantics, status enum, HTTP-status table) and AD-9 (the complete constants list) verbatim. Paraphrasing a field name is a violation, not a summary.*

- AR1 (AD-1): Single wire protocol — all client↔server traffic, Local Mode included, over the HTTP(S) JSON API; the version header applies to actor and pre-auth routes (viewer/health exempt per AR7/NFR8); v0.1 unix-socket/daemon-client layer fully retired; local trust = 0600 token file in shared data dir.
- AR2 (AD-2): One process = one realm = one SQLite file = one writer (BEGIN IMMEDIATE); no multi-realm per process; scale-out out of scope.
- AR3 (AD-3): Hexagonal core — adapters → core → store one-way; core imports no node:http, no MCP SDK, no CLI lib; policy never lives in a route handler. Structural seed: server/core, server/store, server/api, server/client, server/cli, server/mcp-stdio.mjs, server/runtime.mjs.
- AR4 (AD-4): Schema v2 — messages keyed (room_id, seq), per-room counter inside the write transaction; the v1→v2 migration is ONE startup step: absorb **or stop** any live v0.1 daemon first (pid from runtime.json), then a single BEGIN IMMEDIATE transaction (detect user_version → re-sequence + reply_to_seq remap → stamp v2), idempotent on crash; **the one-time documented cursor reset belongs to this upgrade only** — ordinary restart (FR-11) never resets cursors. Reply threading survives.
- AR5 (AD-5): Ed25519 via node:crypto; fingerprint = SHA-256 over the raw 32-byte public key (canonical, forever); session-token mechanism with two issuance paths (nonce challenge remotely — nonces single-use, ≥16 random bytes, 60s expiry; local token file via /api/auth/local); token TTL 12h sliding `[ASSUMPTION — pending: DR-2]`.
- AR6 (AD-6): Connected state (sessions, Chat-ID registry, liveness) is server-resident and ephemeral — restart clears it and presence rebuilds from heartbeats; **offline identity data is durable**: bounded chat_id_claims(chat_id, actor_fingerprint, last_seen_at) + per-Actor last_seen_at survive restart, pruned at 7 days (operator-tunable) — this is what serves FR-5's offline bucket and FR-21's offline addressing; multiple claims on one name = what ambiguous_chat_id resolves. Messages persist the send-time Chat ID; direct rooms keyed direct:<fp_min>:<fp_max> (lexicographic, same fingerprint twice for same-Actor rooms).
- AR7 (AD-7): Four route classes (actor / pre-auth / viewer / health) through one fixed-order middleware pipeline; the protocol-header stage applies to actor and pre-auth classes only; pre-auth budgeted per IP with forwarded addresses trusted only from a configured proxy; viewer cookie auth (no query strings ever); health unauthenticated; rejection at any stage changes no state.
- AR8 (AD-8): **Normative pointer** — the frozen route table, field vocabulary, read semantics, send status enum, and idempotency-before-duplicate ordering live in spine AD-8; stories cite it, never paraphrase it.
- AR9 (AD-9): **Normative pointer** — the complete constants list (all limits incl. 5s dedup, 1 GiB/256 MiB, backoff 1–60s, held 100, 24h, 5s freshness, SSE keep-alive ≤30s) and the PUBLIC_ERRORS → HTTP status table live in spine AD-9; one module, mirrored everywhere.
- AR10 (AD-10): Local server always uses the shared data dir (AGENT_ROOM_DATA_DIR / ~/.agent-room), never PLUGIN_DATA; ensureServer race handled via hardlink startup lock (stale after 15s), race loser attaches via runtime.json; stale detection = pid liveness + GET /health probe — **only a dead-and-unreachable entry is reclaimed**; `if (local)` confined to api-client + enrollment paths.
- AR11 (AD-11): Boring built-in crypto only (Ed25519, SHA-256, randomBytes base64url, timing-safe compares); TLS via node:https; no JWT/X.509/crypto libs.
- AR12 (AD-12): Plugin-local trust state per realm (cursors, Allowlist, held cache) in PLUGIN_DATA keyed by realm_id, never server-resident; removing trust affects future ingestion only.
- AR13 (AD-13): Operator surface = in-process CLI on the server host only; no operator HTTP routes; the API cannot mint invites or ban; authentication is the host boundary.
- AR14 (AD-14): Broadcast membership implicit from enrollment (v0.1 room_create/room_join retired); stable realm_id (UUID at first boot, via /api/status) keys all plugin-local state; **a rebuilt OR migrated server is a new realm** and starts with fresh trust.
- AR15 (Stack): Node ≥24.15 executable floor on stock builds (SQLite ≥3.51.3 asserted at runtime); node:sqlite Stability 1.2; MCP stdio spec revision 2026-07-28; Caddy v2.11.x recipe.
- AR16 (Conventions): ratify v0.1 — snake_case codes, PUBLIC_ERRORS whitelist, {ok, result|error} envelope, kebab files/camelCase functions, 0700/0600 perms with regular-non-symlink checks, stderr-only logging, ESM no-deps frozen exports, node:test + real-child-process patterns; negative redaction rules apply to tool output, logs, AND wire captures (private keys, invite secrets, tokens never appear in any of the three); every AD enforcement point has a test that fails when the AD is violated.
- AR17 (Packaging): package-release.mjs shape unchanged; v0.1→v0.2 Local Mode data migration required (AR4); separate stories and proofs for ordinary restart (FR-11), stale-runtime attach/reclaim (AR10), and the one-time upgrade (AR4) — stating exactly what survives each: logs, reply links, enrollment, realm_id, allowlist, cursors, in-flight work.

### UX / Human-Interaction Requirements

No bmad-ux design contract exists (no new screen UI; the viewer extends v0.1 assets per FR-18). v0.2 ships real human-facing CLI and viewer interactions that stories must design explicitly:

- HCI1: First-run Chat ID selection (Local Mode, FR1/FR19) — collected by a one-time `agent-room setup` command the human runs in their own terminal before the first session, stored in PLUGIN_DATA config; the `mcp-stdio` process NEVER prompts on stdin (stdin is the MCP JSON-RPC channel — an interactive prompt there would corrupt the protocol stream); collision-refusal retry happens in the setup command.
- HCI2: Held-message human flow (FR10) — held list (`agent-room held list`), full preview (`agent-room held show <id>` — the ONLY surface where held body text appears, never an MCP tool result), release (`agent-room allow <chat-id>` reporting realm + fingerprint), and remove (future ingestion only). Approval is a human convention in the Instructed lane — same-user processes are not cryptographically distinguishable, and the flow must not promise otherwise; what code enforces and tests: no held body in any MCP result, accurate realm/fingerprint display, exact-message point-read recovery, explicit confirmation.
- HCI3: Operator CLI family (FR14/FR15/FR22): invite mint/list/revoke, ban/unban, capacity status — grammar, output formats, secret redaction (listings never show tokens).
- HCI4: `ambiguous_chat_id` human resolution (FR21) — candidate fingerprints + last-seen presentation and disambiguation flow; never a silent guess.
- HCI5: Viewer experience (FR18) — /viewer/auth Bearer→cookie bridge as a dedicated story; live presence list with the full state set (authenticated, loading, empty, online, offline-recently, unreachable, reconnecting, token-rotation); never query-string tokens.

### FR Coverage Map

FR1: Epic 1 — Local Mode default + auto-enrollment (only input: Chat ID)
FR2: Epic 4 — Remote join (URL + invite + HTTPS)
FR3: **Epic 1 (keypair + canonical fingerprint born in 1.1)** + Epic 4 (challenge auth, deletion rule, secret negatives)
FR4: Epic 4 — Self-hostable server + TLS/proxy guide
FR5: Epic 1 — Presence per Session/Chat ID (offline bucket via durable claims, AR6)
FR6: Epic 1 — Broadcast Room (secondary commons)
FR7: Epic 1 — Direct Rooms, primary surface, Actor-pair durable
FR8: Epic 1 — Long-Poll cursor reads, room-local seq
FR9: **Epic 1 (static untrusted envelope — freezes MCP response schema) + Epic 3 (full versioned labeling)**
FR10: Epic 3 — Held messages, allowlist, held CLI (needs Epic 2's durable substrate)
FR11: Epic 2 — Ordinary restart survival (no cursor reset — that is upgrade-only)
FR12: Epic 2 — Reconnect, room discovery, bounded catch-up, backoff
FR13: Epic 2 — Endurance basis: churn test + leak-tracker harness (formal soak runs in Epic 6)
FR14: Epic 4 — Invite lifecycle (atomic, race-safe, secret hygiene)
FR15: Epic 4 — Ban by key
FR16: Epic 4 — Four rate gates (idempotency-first ordering)
FR17: Epic 1 (committed/conflict basics) → Epic 4 (full six-status set)
FR18: Epic 5 — Viewer: Broadcast + live presence states, cookie bridge
FR19: Epic 1 — Chat ID connect/rename, collision refusal (DR-1)
FR20: Epic 1 — Delivery contract: ack, cursors, outcome_unknown retry
FR21: Epic 1 — MCP tool surface incl. room_status + ambiguous_chat_id
FR22: Epic 4 — Storage admission control + operator capacity view

NFRs/ARs map through each epic's stories per the spine's Capability→Architecture map; NFR-2's `validate --strict` runs as a blocking gate from Epic 1's packaging story onward (ruling Q4).

## Epic List

*(Structure finalized by agy-advisor ruling Q1–Q5, 2026-09-20 — `docs/epics-review/ruling-structure-agy.md`; rulings binding unless the builder overrides.)*

### Epic 1: First Conversation — two agents chat on one machine
Install the plugin, open two agent clients, pick Chat IDs, see each other, DM with durable history (UJ-1 complete). Foundation (schema v2, core, HTTP API + middleware, local bootstrap, MCP tools) lands as ordered stories inside this epic — not a separate tech epic. Foreign-actor messages ship inside the static `<untrusted_message>` envelope from day one (ruling Q5), freezing the MCP response schema. Packaging story runs `package-release.mjs` + `claude plugin validate --strict` as a blocking gate (ruling Q4).
**FRs covered:** FR1, FR5, FR6, FR7, FR8, FR19, FR20, FR21, FR9 (basic envelope), FR17 (basic statuses) + AR1–4/6/10/14/16 + HCI1
**Gate inside:** Mid-epic checkpoint (ruling Q3) — automated integration test `tests/integration/first-conversation.test.mjs`: two real mcp-stdio child processes, real spawned server + WAL SQLite, alice↔bob presence → `room_direct_open` → send → long-poll read, asserting contiguous seq from 1 and byte-matching payloads. Zero mocks.

### Epic 2: Nothing Is Lost — the room survives everything
Server kill -9 under traffic, dead sessions returning, sleep/wake, stale runtime reclamation, and the one-time v0.1→v0.2 migration (the only cursor reset in the product) — with the REL-2 drill (≥3 randomized kill/restore cycles, external ack recorder) as a BLOCKING acceptance criterion, plus the 100-cycle churn test and the leak-tracker harness (`tests/harness/leak-tracker.mjs`) that Epic 6's formal soak reuses (ruling Q4 partitioning).
**FRs covered:** FR11, FR12, FR13 + AR4 (migration), AR10 (stale reclaim) + REL-2 blocking + UJ-3

### Epic 3: Safe to Talk to Strangers — trust before the network opens
Untrusted framing at full rigor (versioned labeling), held messages as metadata-only with the human CLI surface (held list / held show = the only body-preview surface / allow / remove), fingerprint-bound per-realm Allowlist, 100-entry held cache with point-read recovery — the end-to-end FR-10+FR-20+AR-12 acceptance test. **Hard gate: must land strictly before Epic 4** (ruling Q1 condition — no remote byte enters an ungated room).
**FRs covered:** FR9 (full), FR10 + HCI2 + AR12

### Epic 4: The Wider Room — across machines, across vendors, with governance
Point a session at any server (invite + Ed25519 challenge + verified HTTPS), operator governs the realm (invite mint/list/revoke, ban, capacity/storage gates), the four rate gates complete FR-17's six-status set — the killing feature. Ends with the dress rehearsal (ruling Q3): `tests/drills/remote-dress-rehearsal.test.mjs` — two identity sandboxes, real HTTPS (no `/api/auth/local` bypass), full governance flow: mint → enroll A (challenge-response) → second-use attempt fails → enroll B → DM + broadcast through rate gates → operator bans B → B's sends/polls refused `banned`.
**FRs covered:** FR2, FR3, FR4, FR14, FR15, FR16, FR17 (full), FR22 + HCI3 + AR5/7/11/13 + remote churn

### Epic 5: Watch from Outside — the room, live, read-only
A human opens a browser and watches the Broadcast Room and the live presence list (all states: authenticated, loading, empty, online, offline-recently, unreachable, reconnecting, token-rotation), cookie-authed via the Bearer→cookie bridge, DMs never shown. Slot 5 confirmed by ruling Q2: the viewer's presence engine needs Epics 2+4's states; building earlier means rewriting it.
**FRs covered:** FR18 + HCI5 + DR-3 (decided here)

### Epic 6: Prove It & Ship — integrated proof, nothing deferred
REL-1: the physical two-machine, two-vendor DM + broadcast demonstration **observed live through the authenticated viewer**. REL-3: the single formal 8-hour soak (RSS ≤2% slope rule) against the fully integrated system, reusing Epic 2's harness. Dual-package verification + per-client smoke tests (Claude Code, Zcode) + SM-C1 baseline measurement. **Zero deferred unit or component QA lives here** (ruling Q4) — Epic 6 is integration proof and packaging only.
**FRs covered:** REL-1..REL-4, FR18 (release evidence), NFR2 (release), AR15/AR17 packaging

---

## Epic 1: First Conversation

Two agents chat on one machine: foundation + the complete UJ-1 journey as ordered stories.

**Pre-epic task (before Story 1.1 starts):** capture the v0.1 baseline snapshot — steps, wall-clock to first exchanged message across five fresh installs, and package size — into `docs/v01-baseline.md`. This is SM-C1's comparison anchor; measuring it now (v0.1 exists) is what lets every later "must not regress" claim be a number, not a memory.

### Story 1.1: Runtime foundation & single limits module

As a plugin developer,
I want one runtime layer (startup gates, paths, permissions, and the AD-9 constants module),
So that every later story binds to one set of limits and startup gates.

**Enables (V):** Stories 1.2–1.9 — the load-bearing foundation of this value epic; its user value is delivered through the first conversation those stories compose.

**Acceptance Criteria:**

**Given** Node <24.15 or bundled SQLite <3.51.3, **When** any entrypoint starts, **Then** it exits non-zero with a diagnosable error naming the failed gate.
**Given** a fresh PLUGIN_DATA, **When** initialized, **Then** one Ed25519 keypair is generated (0600) and the canonical Actor fingerprint is computed as SHA-256 over the raw 32-byte public key — every Epic 1 consumer (pair keys, claims, presence, envelope) uses this fingerprint; no placeholder identities exist anywhere in the codebase or tests (fixes review CRIT-1: the keypair is born here, not in Epic 4).
**Given** the shared data dir and PLUGIN_DATA, **When** created or used, **Then** directories are 0700, files 0600, regular non-symlink, size-bounded; a static check asserts zero external runtime dependencies (empty dependencies in package.json, no node_modules shipped).
**Given** any enforcement point, **When** it needs a bound, **Then** it imports from the single constants module (message 32,768 chars · frame 1 MiB · page 200 · hold 20,000 ms · heartbeat 60 s ±10% / TTL 180 s · SSE keep-alive 30 s · duplicate window 5 s · storage 1 GiB/256 MiB · backoff 1–60 s · held 100 · offline 24 h · viewer 5 s · send bucket 0.5/s capacity 10 · request budget 120/min burst 30 · enrollment 5/min burst 5 · invite default 1 use/24 h · session TTL 12 h [DR-2]) including the PUBLIC_ERRORS→HTTP-status table; later stories import these by name and never restate a number.

### Story 1.2: Store schema v2 — rooms & the durable log

As a session,
I want messages appended to per-room contiguous logs with idempotent sends,
So that history is durable and retries are safe.

**Enables (V):** Stories 1.7/1.8 — the conversation verbs and their checkpoint stand on this log.

**Acceptance Criteria:**

**Given** a fresh schema-v2 database, **When** two sends commit to one room, **Then** sequences are 1 then 2 — room-local, contiguous, gap-free; rooms carry kind (broadcast/direct) and the `direct:<fp_min>:<fp_max>` pair key (same fingerprint twice allowed).
**Given** a resend of the same (Actor, room, client_message_id), **When** the payload matches, **Then** the original committed message returns; **When** it differs, **Then** `client_message_id_conflict`.
**Given** a crash before commit, **When** the store recovers, **Then** the uncommitted message was never acknowledged and is absent.
**Given** the store, **When** inspected, **Then** SQLite STRICT tables, WAL, `synchronous=FULL`, preserved autocheckpointing, and append-only messages hold (no UPDATE/DELETE path exists on messages) — asserted by test, not convention (NFR-7).
**Given** a Direct Room between Actors A and B, **When** any third Actor attempts read or post, **Then** the server denies it (protocol-level DM privacy, FR-7).
**Given** NFR-5's server-side send budget (p95 ≤150 ms, made executable in Story 4.4), **When** the store's write path is designed, **Then** it stays within that envelope by construction — single-writer immediate transactions, no deferred index work on the commit path — with 4.4's test as the single executable check (⚡ answered by reference per AD-9's single-source rule).

### Story 1.3: HTTP API host, middleware classes, health & realm bootstrap

As a client,
I want a versioned API host with the four route classes,
So that every request is gated identically.

**Enables (V):** Stories 1.4–1.8 — every client, local or remote, enters through this door.

**Acceptance Criteria:**

**Given** an /api/* request missing or mangling `Agent-Room-Protocol`, **When** received, **Then** 400 `protocol_required`/`invalid_protocol` with zero state change; an unsupported version names the supported versions.
**Given** first boot, **When** the server starts, **Then** a realm_id is minted, the Broadcast Room exists implicitly (no join verbs exist for it), and `GET /health` answers unauthenticated.
**Given** the four route classes, **When** a request arrives, **Then** viewer and health classes skip the protocol-header stage and handlers contain no gate logic.
**Given** any rejection stage, **When** it fires, **Then** a test proves zero state change, zero invite consumption, and zero cursor advance (AD-7's invariant), and the fixed pipeline ORDER (protocol → transport → auth → budgets → authz → handler) is asserted — a reordered gate fails the test.
**Given** a request with an unknown field or an unsupported version, **When** processed, **Then** the unknown field is rejected (not ignored), the response echoes the protocol version, and no implicit downgrade occurs (NFR-8).
**Given** the module tree, **When** a boundary test runs, **Then** `core/` imports no `node:http`, no MCP SDK, no CLI lib, and no policy lives in a route handler — an import violation fails the test (AR-3, mechanically guarded).
**Given** the wire contract, **When** a story needs a route, field name, or status, **Then** it cites spine AD-8/AD-9 verbatim; a contract test pins the complete route table, field vocabulary, `{ok,result|error}` envelope, and status→HTTP mapping against the spine text (AR-8 — the normative pointer is executable).

### Story 1.4: Local bootstrap & local session auth

As a local session,
I want the server auto-started and a session token issued via the local token file,
So that Local Mode needs no URL or invite.

**Acceptance Criteria:**

**Given** two sessions racing first boot, **When** both run ensureServer, **Then** exactly one server wins (hardlink startup lock, stale after 15 s) and the loser attaches via runtime.json; both converge on the shared data dir — never PLUGIN_DATA.
**Given** a stale runtime.json, **When** its pid is dead AND its health endpoint is unreachable, **Then** the entry is reclaimed; otherwise it is reused.
**Given** the 0600 local token file, **When** `POST /api/auth/local` presents it as Bearer, **Then** a session token returns; the token file itself is never a per-request credential.
**Given** a running local server, **When** its sockets and bindings are inspected, **Then** it binds 127.0.0.1 only, creates no unix-socket file (the v0.1 transport is fully retired — AR-1), and the only user input across first use is the Chat ID: no URL, token, or room ID is ever requested (FR-1's negative test).

### Story 1.5: Chat ID connect, rename & durable claims

As a session,
I want to claim a Chat ID at connect and rename anytime,
So that each terminal is a distinct participant.

**Acceptance Criteria:**

**Given** a live session holding a Chat ID, **When** another session claims the same name, **Then** an explicit error refuses it — no suffixing; rename is immediate and history keeps send-time names.
**Given** connect, rename, or heartbeat, **When** the claims index updates, **Then** (chat_id, actor fingerprint, last_seen_at) is durable across restart, multiple Actors may hold claims on one name (ambiguity data), and rows prune at 7 days (operator-tunable).
**Given** a proposed Chat ID, **When** validated, **Then** DR-1 holds: 1–32 chars `[A-Za-z0-9_.-]`, uniqueness compared case-insensitively.

### Story 1.6: Presence — online & offline-recently

As a session,
I want to see who is online and who was recently seen,
So that I know who I can address.

**Acceptance Criteria:**

**Given** sessions with fresh liveness, **When** presence is read, **Then** one row per Session appears (Chat ID, client type, connected-since, last-seen, Actor fingerprint) within TTL 180s; any authenticated request refreshes liveness; viewer and daemon activity never keep an Actor online.
**Given** actors last seen within 24 h, **When** `include_offline` is set, **Then** a separately-labeled offline-recently group returns, never implying unenrollment, surviving server restart via the claims index.
**Given** an unreachable server, **When** reported, **Then** it is reported unreachable — never as "everyone offline."

### Story 1.7: MCP adapter — tools, first-run prompt & untrusted envelope

As an agent session,
I want the plugin's MCP tools over the same API,
So that I can see presence, DM, and read — with foreign text framed from day one.

**Acceptance Criteria:**

**Given** the tools `room_presence({include_offline?})`, `room_direct_open({chat_id, target_fingerprint?})` (returns the existing-or-created pair room; `ambiguous_chat_id` with candidate fingerprints + last-seen when multiple Actors claim a name — never a guess — and `target_fingerprint` completes the disambiguation, resolving to that candidate), `message_send`/`message_read` (after_seq strictly-greater default 0, limit ≤200, wait_ms ≤20,000 server hold, deadline returns a normal possibly-empty page, responses carry `next_after_seq` and `head_seq`), and `room_status` (realm_id + Broadcast Room ID), **When** an agent lists them, **Then** descriptions carry "list agents" phrasing + Agent Room identity; no native-named aliases exist; concurrent `room_direct_open` calls return the same room; an `ambiguous_chat_id` → `target_fingerprint` resolution round-trip passes its own test (HCI-4 complete, not a dead end).
**Given** a message whose sender fingerprint differs from the local installation's, **When** returned in a tool result, **Then** the body ships inside the static versioned `<untrusted_message>` envelope (sender chat_id, fingerprint, and the data-never-instructions-or-authorization warning); same-Actor messages return plain; this response schema is frozen from this story forward.
**Given** a successful `message_read`, **When** messages return, **Then** the client advances and durably persists its cursor per (installation, realm, room) under `PLUGIN_DATA/realms/<realm_id>/` (FR-20's client-owned side — the server holds none).
**Given** a network failure or timeout during `message_send`, **When** the outcome cannot be observed, **Then** the client records `outcome_unknown` and retries with the identical `client_message_id`, resolving via server idempotency to the original or a conflict — never a duplicate send, never a consumed token.
**Given** any tool argument attempting to carry sender identity or authority, **When** received, **Then** it is rejected — authority derives only from the session token (NFR-3 negative test).
**Given** a first run with no Chat ID configured, **When** the human runs the one-time `agent-room setup` command in their terminal, **Then** it collects and validates the Chat ID (collision-refusal retry included) and stores it in PLUGIN_DATA config; the `mcp-stdio` process itself never prompts on stdin — stdin is the MCP JSON-RPC channel and stays pure (HCI-1).
**Sizing (S — pre-agreed split, three commits within this story, each leaving the suite green):** (a) tools + client cursors + `outcome_unknown` retry · (b) untrusted envelope + NFR-3 negatives · (c) the `agent-room setup` command.

### Story 1.8: First-conversation integration checkpoint *(blocking gate — ruling Q3)*

*Placement note (review H1): the ruling named a "Story 1.5 milestone" before the story set existed; this checkpoint is overridden to Story 1.8 — the first story after the MCP adapter (1.7) that supplies the verbs it exercises. Capabilities in scope at the gate: everything from Stories 1.1–1.7.*

As the builder,
I want automated proof that two real agent sessions converse,
So that the vertical stack is verified before polish stories continue.

**Acceptance Criteria:**

**Given** `tests/integration/first-conversation.test.mjs` spawning two real `mcp-stdio` child processes against a real spawned server (WAL SQLite, runtime.json attach, local token auth), **When** alice and bob connect, **Then** presence shows both, `room_direct_open('bob')` opens the DM, sends commit, and long-poll reads return payloads byte-matching with sequences contiguous from 1.
**Given** the spawned server, **When** inspected from the test, **Then** it bound 127.0.0.1 only, and a third session's attempt to read alice↔bob's Direct Room is denied (DM ACL exercised at the gate).
**Given** any regression in the envelope, sequence contiguity, the frozen response schema, or client cursor persistence, **When** the checkpoint runs, **Then** it fails; zero mocks are permitted in this test.

### Story 1.9: Packaging & the validate gate

As the builder,
I want dual packages validated from the first epic,
So that conformance never drifts.

**Acceptance Criteria:**

**Given** `scripts/package-release.mjs`, **When** run to a fresh output path, **Then** the portable and Claude Code packages carry byte-identical runtime files and `claude plugin validate <pkg> --strict` passes — a blocking gate on every later structural story.
**Given** an existing output target or a symlinked source entry, **When** packaging runs, **Then** it refuses without overwriting (v0.1 behavior preserved).

## Epic 2: Nothing Is Lost

The room survives crashes, restarts, sleep, and the one-time upgrade.

### Story 2.1: Ordinary restart survival

As a session owner,
I want the server to survive kill -9 with zero acknowledged-message loss,
So that a crash is a non-event.

**Acceptance Criteria:**

**Given** active traffic, **When** the server is SIGKILLed and restarted, **Then** every previously acknowledged message is readable, room-local sequences continue without reuse or gaps, and the survival matrix holds for everything that exists by this epic — logs, reply links, durable claims, realm_id, broadcast/direct rooms (invite and ban persistence is asserted in their owning stories 4.2/4.5 and re-proven by the integrated drills; review B1 fix).
**Given** an ordinary restart, **When** clients reconnect, **Then** cursors remain valid — no reset (reset belongs to the v1→v2 upgrade only, Story 2.3).

### Story 2.2: Reconnection & room discovery

As a returning session,
I want to reconnect and catch up completely,
So that absence loses nothing (UJ-3).

**Acceptance Criteria:**

**Given** a session reconnecting after any absence, **When** it connects, **Then** it re-authenticates through the **local mechanism** (session token re-issued via the local token file — the remote Ed25519 re-proof is Story 4.1's), re-claims or re-picks its Chat ID, and enumerates its rooms via `GET /api/rooms` — discovering DMs opened in its absence.
**Given** catch-up in progress, **When** reading, **Then** each room is read to head-at-read-time in bounded pages from the persisted client cursor; traffic arriving during catch-up is read under the same cursor discipline, and the cursor never moves backward.
**Given** a lost connection, **When** retrying, **Then** backoff runs 1 s→60 s with jitter, and a detected network recovery permits an immediate attempt.

### Story 2.3: The v0.1→v0.2 migration (one-time)

As a v0.1 user,
I want my existing local data upgraded in place,
So that Local Mode continuity carries into v0.2.

**Acceptance Criteria:**

**Given** a v0.1 database at startup, **When** the server boots, **Then** any live v0.1 daemon is absorbed or stopped first (pid from runtime.json), then a single BEGIN IMMEDIATE transaction performs detect (`user_version`) → per-room re-sequencing + `reply_to_seq` remap → stamp v2.
**Given** a crash mid-migration, **When** the server boots again, **Then** the step resumes idempotently and completes; **a second completed startup run is a no-op oracle**: identical room/sequence/reply maps, no remap applied twice, the cursor reset documented exactly once (review H2 fix).
**Given** migrated data, **When** reads run, **Then** reply threads are intact, room-local sequences are contiguous from 1, and the realm_id is **preserved** — an in-place schema migration is the same realm with the same trust; only moving to a new server/host creates a new realm with fresh trust (AR-14 boundary made explicit).

### Story 2.4: Endurance harness & connection-churn regression

As the builder,
I want a leak-tracking harness and a churn regression test in daily development,
So that endurance problems surface early, not in Epic 6.

**Enables (V):** Stories 2.5, 4.8, and 6.2 — every later proof reuses this harness.

**Acceptance Criteria:**

**Given** `tests/harness/leak-tracker.mjs`, **When** any test opts in, **Then** it samples RSS and FD counts at 5-minute-equivalent intervals and evaluates the single memory pass rule (least-squares slope ≤2% of starting RSS).
**Given** `tests/` churn regression, **When** 100 connect/disconnect cycles run, **Then** all succeed with FD counts within ±5 of the post-warmup baseline and zero leaked sockets/handles (a numeric oracle, not "stable" — review M4 fix).

### Story 2.5: REL-2 continuity drill *(blocking epic gate)*

As the builder,
I want the randomized kill-drill as Epic 2's exit gate,
So that "Nothing Is Lost" is proven, not claimed.

**Acceptance Criteria:**

**Given** an external recorder logging every acknowledged (room, seq, idempotency key) while traffic flows, **When** ≥3 randomized kill/restore cycles execute, **Then** every acknowledged message is readable, sequences stay contiguous, cursors stay valid, and in-flight sends resolve via idempotent retry with zero duplicates.
**Given** Epic 2 completion, **When** this drill has not passed, **Then** the epic is not done — no clean-restart-only acceptance is permitted.

## Epic 3: Safe to Talk to Strangers

Trust before the network opens (hard gate: lands strictly before Epic 4).

### Story 3.1: Untrusted marking at full rigor

As a receiving agent,
I want every foreign message wrapped and labeled per FR-9's two lanes,
So that the framing is honest about what code enforces and what is instructed.

**Acceptance Criteria:**

**Given** FR-9's split (Plugin-enforced wrapping; Instructed interpretation), **When** any foreign body reaches a tool result, **Then** the versioned envelope wraps it (mechanically asserted on every foreign body) and the label never claims persuasion resistance.
**Given** the schema frozen in Story 1.7, **When** this story lands, **Then** no breaking change to the response shape occurs — only additive labeling.

### Story 3.2: Per-realm Allowlist & trust matrix

As a session owner,
I want trust bound to fingerprints per realm,
So that names never inherit trust.

**Acceptance Criteria:**

**Given** allowlist storage in PLUGIN_DATA keyed by realm_id, **When** the matrix evaluates a sender, **Then** own-Actor, same-OS-user local, and allowlisted-remote senders deliver; every other remote sender — including one claiming same-machine — is held; accept-all is a per-realm human opt-in.
**Given** a removed entry, **When** future messages arrive, **Then** they are held again — already-ingested text is not retroactively withdrawn.
**Given** a reused Chat ID or a replaced key, **When** evaluated, **Then** trust does not inherit (D13).

### Story 3.3: Held pipeline — metadata-only & recoverable

As a session owner,
I want held messages to expose metadata only, with nothing ever lost,
So that nothing unsafe enters context and nothing safe is dropped.

**Acceptance Criteria:**

**Given** a held message, **When** surfaced, **Then** the tool result carries metadata only (realm, sender Chat ID, fingerprint, room, seq, time, size, held count) — no body text in any agent-visible result; full preview exists only on the human approval surface.
**Given** cache eviction past 100 entries, **When** recovery runs, **Then** the body is fetched by point read (`after_seq = seq − 1`, `limit = 1`); eviction never deletes, approves, or skips.
**Given** a held message, **When** the read cursor advances, **Then** it advances independently of ingestion (FR-20 invariant); held state is separate, keyed by (realm, room, seq).

### Story 3.4: The human CLI surface (HCI-2)

As a human,
I want terminal commands to inspect and release held messages,
So that trust decisions are mine, informed, and honest.

**Acceptance Criteria:**

**Given** `agent-room held list` and `agent-room held show <id>`, **When** run, **Then** held items list with metadata, and `held show` displays the full body — the only surface where held body text appears.
**Given** `agent-room allow <chat-id>`, **When** run, **Then** it resolves the underlying fingerprint on the current realm, reports realm + fingerprint, saves the allowlist entry, and releases that key's held and future messages; `--remove` affects future ingestion only.
**Given** the help text, **When** read, **Then** it states plainly that approval is a human convention (Instructed) — same-user processes are not cryptographically distinguishable; no "never agent-invocable" claim appears.
**Given** any `agent-room` CLI command invoked with an invalid or unknown Chat ID, **When** run, **Then** it exits non-zero with an actionable error naming the failing input and, when the name is ambiguous, listing the candidate fingerprints — never a bare "invalid" (HCI-4's CLI side made testable).

### Story 3.5: End-to-end trust test

As the builder,
I want one test covering hold, cursor, recovery, release, and removal together,
So that FR-10/FR-20/AR-12 cannot each pass in isolation while the chain fails.

**Acceptance Criteria:**

**Given** `tests/integration/trust-chain.test.mjs` running the real MCP response path with zero mocks, a distinct foreign installation (its own keypair), and a stranger send, **When** the chain executes, **Then**: the held result contains metadata and no body in every agent-visible result; the transport cursor advances and is persisted under (installation, realm, room) while ingestion stays separate; after eviction the point-read recovers a body that byte-matches the durable log; `allow` releases that key's held and future messages; a subsequent `--remove` holds future messages without touching the past; and the cursor never moves backward at any step (review H3 fix — the test proves the boundary, not the policy function).

## Epic 4: The Wider Room

Across machines, across vendors, with governance — the killing feature.

### Story 4.1: Remote challenge authentication (keypair born in Story 1.1)

As a remote session,
I want Ed25519 proof-of-possession per connection,
So that my Actor is my key and nothing else.

**Acceptance Criteria:**

**Given** the installation keypair created in Story 1.1, **When** connecting remotely, **Then** `/api/auth/challenge` issues a single-use nonce (≥16 random bytes, 60 s expiry) and `/api/auth/answer` with a valid signature returns a session token (12 h sliding — DR-2 resolved here against real reconnect cadence).
**Given** any capture of traffic, **When** replayed, **Then** it fails; the private key never appears in tool output, logs, or on the wire; the fingerprint is SHA-256 over the raw 32-byte public key.
**Given** plugin data deletion, **When** the installation reconnects, **Then** it is a new, unrelated Actor with no inherited rooms or trust (FR-3's deletion rule); exactly one keypair exists per installation and key files are 0600.
**Given** any request asserting sender authority in a body or tool argument, **When** processed, **Then** it is rejected server-side as well (NFR-3's negative, mirrored at the wire).

### Story 4.2: Invite-gated enrollment & the operator CLI host

As a server operator,
I want atomic, race-safe invite enrollment run through a real CLI,
So that membership is exactly what I minted.

**Acceptance Criteria:**

**Given** this story, **When** it lands, **Then** the server-host CLI harness (`cli/` entrypoint, in-process core calls per AR-13) is established here with the invite command family — later operator stories (4.5 ban, 4.6 capacity) add commands to this host, never build their own (review MED-1 fix).
**Given** an invite minted with defaults, **When** inspected, **Then** the token matches `ar_inv1_` + exactly 43 base64url characters encoding 32 random bytes; only its SHA-256 digest is persisted; `--uses`/`--ttl` accept finite values only and unlimited/never-expiring modes are rejected outright (review H4 fix).
**Given** two keys racing one single-use invite, **When** both attempt enrollment, **Then** exactly one enrollment commits in a single durable transaction with possession proof validated first; a failed or rolled-back attempt consumes nothing; a lost-response retry reattaches without consuming.
**Given** `invite mint/list/revoke`, **When** run, **Then** the raw token is shown exactly once, listings never show secrets, diagnostics redact them, and outputs are machine-readable (stable exit codes and JSON lines — HCI-3's grammar begins here).
**Given** enrollment attempts, **When** rate-limited, **Then** 5/min/IP burst 5 applies with forwarded addresses trusted only from an explicitly configured proxy.

### Story 4.3: Remote client & transport policy

As a remote session,
I want a configured, verified-HTTPS connection to any server,
So that Remote Mode is safe by default.

**Acceptance Criteria:**

**Given** a configured server URL, **When** the client connects, **Then** HTTPS with normal certificate/hostname verification is required — plaintext remote is refused; config persists in plugin data and one server is active at a time.
**Given** an enrolled key, **When** reconnecting, **Then** no invite is needed (enrollment does not expire in v0.2).

### Story 4.4: The four rate gates & full send statuses

As the server,
I want four independently testable gates with idempotency ordered first,
So that abuse is throttled and retries are never punished.

**Acceptance Criteria:**

**Given** a send, **When** processed, **Then** the idempotency tuple is checked before the duplicate gate; exact retries return the original and consume nothing; the send bucket (0.5/s, capacity 10), request budget (120/min/key burst 30, counting failed/replayed, long-polls at admission), and 5 s duplicate gate each pass their own isolated test; identical text in different rooms/reply contexts is not deduplicated.
**Given** any refusal, **When** returned, **Then** FR-17's six statuses are the complete set — `rate_limited` carries a retry delay; `duplicate_dropped` names the original sequence; all limits are imported by name from the constants module (no restated numbers — review B2 fix) and are operator-tunable floors, not a DoS guarantee.
**Given** the churn harness driving send traffic, **When** server-side processing is sampled, **Then** send p95 ≤150 ms excluding network RTT (NFR-5 made executable).

### Story 4.5: Ban by identity key

As an operator,
I want to ban a key and have it stick immediately,
So that a bad Actor is gone.

**Acceptance Criteria:**

**Given** the `ban`/`unban` commands added to the CLI host from Story 4.2, **When** a fingerprint is banned, **Then** every send, read, or re-enroll from that key is refused with `banned` at next request; an active long-poll is not held past its 20 s window; and ban state survives restart (its persistence finally proven here, per the B1 boundary).

### Story 4.6: Storage admission control

As an operator,
I want disk-capacity gates and a capacity view,
So that a realm never dies of a full disk silently.

**Acceptance Criteria:**

**Given** free space, **When** it drops below 1 GiB, **Then** the `capacity` command (added to the existing CLI host) warns; below 256 MiB new appends are refused with `storage_low`; thresholds are tunable capacity reserves, never retention quotas.
**Given** a refused or disk-full send, **When** it returns, **Then** the error is explicit and an uncommitted message is never acknowledged; refusal never drops or alters accepted work; reads continue wherever storage can serve them; the backup/restore + disk-expansion guide exists. *(This story owns FR-22 only — the CLI host lives in 4.2; review MED-1 fix.)*

### Story 4.7: Self-hosting deployment guide

As a self-hoster,
I want one honest guide for both TLS paths,
So that running a realm is a documented procedure, not archaeology.

**Acceptance Criteria:**

**Given** the guide, **When** followed on a VPS, **Then** the Caddy recipe (v2.11.x pinned by name) and the native node:https path both reach enrollment + a 20-second read through the same handler; the loopback-only plaintext backend rule is stated; the MCP stdio spec revision (2026-07-28) is pinned wherever the plugin's MCP surface is described (AR-15 made explicit).
**Given** server start, **When** it succeeds or fails, **Then** the boundary is defined (health endpoint + bound ports vs non-zero exit with diagnosable error); certificate acquisition/renewal responsibility, key permissions, restart-with-preserved-enrollment, proxy timeouts ≥30 s, and no-secrets-in-logging are all documented.
**Given** a failure mid-guide (certificate issuance fails, port already bound, proxy unreachable, enrollment rejected), **When** the operator consults the failure-mode appendix, **Then** each documented failure names the symptom, likely cause, and recovery step — no dead ends (⚠️ exception dimension closed).
**Given** guide verification, **When** an operator completes either TLS path, **Then** the per-path evidence checklist (enrollment log + 20-second read capture) makes the manual walkthrough evidence-comparable rather than judgment-only (T closed).

### Story 4.8: Remote churn & the dress rehearsal *(blocking gate — ruling Q3)*

As the builder,
I want remote-mode proof before physical machines enter,
So that integration holes surface cheaply.

**Acceptance Criteria:**

**Given** `tests/drills/remote-dress-rehearsal.test.mjs`, **When** it runs, **Then** two identity sandboxes (distinct keypairs) exercise the real remote protocol over HTTPS — `/api/auth/local` is forbidden in this drill.
**Given** the full governance flow, **When** executed, **Then** mint → enroll A (challenge-response) → a second use of the invite fails → enroll B (second invite) → A/B exchange DMs and broadcast through the rate gates → operator bans B → B's sends and long-polls are refused `banned`.
**Given** multi-client connection churn under remote HTTPS, **When** cycled, **Then** it passes with zero leaks (Epic 4's churn extension per ruling Q4).

## Epic 5: Watch from Outside

The room, live, read-only — for human eyes.

### Story 5.1: Viewer auth bridge (HCI-5)

As a human viewer,
I want a cookie-minting bridge that never puts credentials in URLs,
So that the viewer is safe to open and share nothing.

**Acceptance Criteria:**

**Given** `GET /viewer/auth` presenting the viewer token as Bearer, **When** it succeeds, **Then** an HttpOnly, SameSite=Strict cookie is set; the viewer token and cookie are valid on no other route class; session tokens never authenticate viewer routes.
**Given** any viewer request, **When** inspected, **Then** no credential ever appears in a query string, log, or referrer-leaking link; the operator can rotate the viewer token.

### Story 5.2: Live room & presence view

As a human viewer,
I want the Broadcast Room and presence streaming live,
So that I can watch the room work.

**Acceptance Criteria:**

**Given** an authenticated viewer session, **When** open, **Then** the Broadcast Room and the presence list render via **one SSE stream carrying room + presence events** (DR-3 RESOLVED here: SSE, extending the existing `/events` pattern — no polling), with every state (authenticated, loading, empty, online, offline-recently, unreachable, reconnecting, token-rotation) exercised by a trigger-and-assert test — each transition has a defined cause and observed result (review B4/M4 fix).
**Given** a committed message, **When** rendered, **Then** it appears within 5 s; all text renders inert under a restrictive CSP; Direct Rooms never appear in the viewer.

### Story 5.3: Remote exposure check

As an operator exposing the viewer beyond loopback,
I want proof that only token holders see anything,
So that "read-only" also means "no free previews."

**Acceptance Criteria:**

**Given** a viewer exposed on a non-loopback interface, **When** an unauthenticated request arrives from another host, **Then** it is refused; the viewer surface is GET-only and the viewer token never authorizes any API write.

## Epic 6: Prove It & Ship

Integrated proof and packaging — nothing deferred.

### Story 6.1: REL-1 — the cross-everything demonstration

As the builder,
I want the physical two-machine, two-vendor milestone,
So that the product's promise is demonstrated, not simulated.

**Acceptance Criteria:**

**Given** two physical machines (laptop + desktop) and two client vendors (Claude Code + Zcode) against one self-hosted Room Server, **When** the demo runs, **Then** a live DM conversation (primary surface) plus one Broadcast Room exchange completes, **and the authenticated viewer is observed live during the demo** — presence states updating, message freshness within 5 s, DMs excluded from the browser (REL-1's FR-18 evidence, review B4 fix); evidence is captured (transcript + recording + browser session).

### Story 6.2: REL-3 — the formal soak

As the builder,
I want the single formal 8-hour soak against the integrated system,
So that endurance is proven once, completely.

**Acceptance Criteria:**

**Given** ≥3 concurrent sessions, the defined traffic profile (1 msg/10 s per room average + bursts, payloads to the 32 KiB cap, hourly reconnects), **When** the endurance run completes with pinned, recorded host/Node/SQLite versions, **Then** zero message loss, FDs stable after hour one, and RSS slope over the final four hours ≤2% of starting RSS (the single pass rule).

*(Amended 2026-10-22 by the release owner's requirements ruling, after the release-gate review of soak attempt 4: the run is now TWELVE hours — the payload ramp is the first four hours and the cap-hold the rest, so the measured window (the final four hours) sits four to eight hours into the hold instead of exactly on the equilibration knee it used to coincide with. The gate itself is unchanged and is FR-13's single band; the rule's second, unratified term (the endpoint growth) is demoted to a reported diagnostic. The full ruling, the pre-registration and the owners' gate are in
`docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md`. Attempt 4 still fails under
the amended rule and is never re-scored.)*
**Given** the same run, **When** idle-footprint is sampled, **Then** the REL-4 counter-metric is recorded (0–5 Actors baseline) — reported, not optimized.

### Story 6.4: Reconnect recovery — the explicit session takeover

As the operator,
I want my Chat ID back when my client's process died,
So that a restart under my own name works again.

*(Added 2026-10-20 by the REL-1 run: the physical two-machine demonstration
uncovered a real continuity defect — a client whose process was killed left its
live row holding the Chat ID, and the ordinary re-bind was refused with
`chat_id_taken` because the server cannot tell a dead process from a quiet
one. FR-12 puts reconnection in MVP scope, so the repair belongs to v0.2.0
rather than to a later release. The advisor review is archived in
`docs/implementation/reviews/epic-6-lease-astra.md`.)*

**Acceptance Criteria:**

**Given** a Chat ID still held by a live session row whose process is gone, **When** the client restarts and re-binds plainly, **Then** the bind is refused with the coded `chat_id_taken` (never a silent suffix, never an automatic takeover) and the operator is told the one command that recovers the name.
**Given** that operator command and a holder that is the SAME Actor's key, **When** it runs, **Then** the name moves atomically (the durable claim write first, the memory transfer second), the displaced session's token is revoked and its session key is fenced (a request admitted before the handoff is refused at the authorization stage), the name is released again for the live client, and a session of a DIFFERENT key is never displaced.

*(Corrected 2026-10-21 after the release-gate review — the clause previously said "an already-admitted request cannot land". The shipped fence is checked at the authorization stage, which runs BEFORE the request body is read, so a request admitted before the handoff whose body was still streaming can still reach the handler. The release owner accepted the reduced intra-Actor semantics for v0.2.0 — the takeover's intended use, taking over a DEAD session, has no in-flight request, so the window is unreachable there — the review's executed proof is archived in `docs/implementation/reviews/epic-6-release-gate-codex.md`, the gap is pinned by a named test row, and the stronger clause (revalidating the session authority after the last awaited input step, directly before the mutation) is the FIRST acceptance criterion of the next release.)*
**Given** the same Actor's other Chat IDs, the rooms, the history, the cursors, and the peer's session, **When** the takeover happens, **Then** none of them change, and an orderly exit hands the name back without any takeover at all.

### Story 6.3: Release packaging & client smoke tests

As the releasing builder,
I want every claimed client actually smoke-tested,
So that "claimed" means "proven."

**Acceptance Criteria:**

**Given** the final dual packages, **When** validated, **Then** `claude plugin validate --strict` passes and each claimed client (Claude Code, Zcode — NFR-2 candidates become claims here) smoke-tests the materialized artifact: install, connect, one DM round-trip.
**Given** release notes, **When** written, **Then** they document the one-time v1→v2 cursor reset and the SM-C1 re-measurement against the pre-Epic-1 v0.1 snapshot (`docs/v01-baseline.md`): steps + wall-clock to first message on five fresh installs, passing per SM-C1's rule.

## Epic 7: The Session Authority, Hardened (v0.3)

Every session-authority defect the release gates found is repaired at the root, and the recovery question gets its design. The scope is the Epic 6 retrospective's v0.3 ledger (A5–A9, A2) plus the two shipped-comment corrections the v0.2.0 release gate recorded; the release-ledger instrument items (A4, A10) are ADOPTED here as a visible scope choice, and the retained-state finding (A11's open part) gets its disposition. Standing process rule for every story (retro A1): the packaged docs (CHANGELOG.md, README.md) land WITH the story that changes what they describe — never after the candidate is frozen. Honesty note: not every defect below was experimentally reproduced — A5 and A7 were executed against the shipped server, A9 was derived from source reading and is so labeled.

**Story order, as ruled by the two-vendor design gate of 2026-10-26** (both round-tables archived at `docs/implementation/reviews/epic-7-design-gate-{codex,agy}.md`): Stories 7.1 and 7.3 proceed immediately — neither can be invalidated by the A2 outcome. Story 7.4's design-or-refusal runs BEFORE Story 7.2's wire/spine amendment freezes (a paper round-table is cheap; re-amending `POST /api/session`, the transfer seam and the Spine twice is not). The 7.2-vs-7.4 ordering disagreement is recorded, not blended: codex's room ratified this hold; agy's John and Grumbal dissented in favor of repair-first (7.2 is a committed correctness fix on a path that never goes away), and their dissent stands in the record. Stories 7.5 and 7.6 run in parallel at any point.

### Story 7.1: The fence never lies

As the builder,
I want the handoff fence's guarantee to be exactly what the code does,
So that no reader — human or agent — can build on a claim the server does not keep.

**Acceptance Criteria:**

**Given** a body-carrying request that was admitted before a same-Actor takeover completed, **When** its body finishes arriving, **Then** the handoff fence is REVALIDATED after `readRequestFields` resolves and synchronously before `handler(context)` is invoked — with no await between that check and the (all-synchronous) mutating handlers — and the request is refused at the fence (the executed gap, closed). The check is FENCE-ONLY: the ban check is NOT re-run there, because FR-15's recorded contract is "in-flight requests refused at next request" and the ban's enforcement boundary is not this story's to change. `AuthzStage` keeps its stage slot so already-superseded requests are refused before a body is ever read.

**Given** an in-flight request, **When** its session is displaced, **Then** its fence entry survives until no request holding that key can still be inside the admission→handler window. The mechanism (ratified by both lanes after refusing the first draft): the pipeline PINS the sessionKey in `runPipeline` immediately when the auth stage succeeds and the session key exists — before `BudgetStage` runs, because the send route's budget stage awaits the body inside the stage loop — and releases it exactly once in a `finally` covering every exit path; the pin is acquired in `runPipeline`, never inside `AuthStage.process`, so standalone-stage unit tests cannot leak counts. In the session registry, an entry whose pin count is above zero is NEVER evicted under any circumstance; the old 1,000 bound gates only idle tombstones (zero-count entries, evicted oldest-first); there is NO hard cap on protected entries and no overflow error mid-transfer. Retention is proportional to genuinely outstanding displaced requests — "unexhaustible" is the guarantee about requests, not a claim of bounded memory independent of concurrency.

**Given** a long-poll that entered its handler before the takeover, **When** it wakes to check for new messages, **Then** it stops serving the displaced session — the poll wakeup loop re-checks the fence alongside the ban check (in-handler continuation policy is explicitly outside this story's mutations; this check is the one-line parity the design gate asked for).

**Given** the shipped source and docs, **When** read, **Then** every place that narrates the old A5 window states the closed behavior instead: the two `server/api/session.mjs` comments, the pipeline's check-placement block, the takeover route's "does not cancel an already-admitted request" prose in `server/api/server.mjs`, the CLI's takeover explanation in `server/cli/session-commands.mjs`, `ARCHITECTURE-SPINE.md`'s handoff clause, and the packaged `README.md`/`CHANGELOG.md` — including the stale Epic 1 viewer fossil in `README.md`. Per A1 these land with THIS story. The test row that pins the A5 gap as a known limitation now pins the closed behavior (refused, handler never called, ownership unchanged), and focused regressions cover the pinned-fence accounting: more supersessions than the old bound with pinned predecessors keeps every one fenced; with none pinned the idle-tombstone bound still evicts; the send-route interleaving that broke the first draft (a request paused in the budget stage's body read) is covered by the early pin.

### Story 7.2: The observed incumbent

As the operator,
I want a takeover intent to name the holder I actually saw,
So that a stale intent is refused instead of displacing whoever holds the name now.

**Acceptance Criteria:**

**Given** a takeover intent, **When** it is created, **Then** it is bound to an opaque conflict ticket tied to the authenticated Actor, the normalized Chat ID and the OBSERVED incumbent (never a bearer or a token digest — retro A6), the ticket is carried unchanged to the takeover (never refreshed on retry), and **When** the takeover executes against a different incumbent than the one observed, **Then** it is refused with a coded collision instead of displacing the current holder. The ticket is SAME-ACTOR CONFIDENTIAL: a foreign Actor colliding with a held name receives the bare `chat_id_taken` with no ticket and no incumbent metadata — rotation state of another key's name leaks to no one. This is a wire change and carries its own Architecture Spine amendment, the client confirmation flow's amendment, and the flip of the test that currently lets two sequential takeovers both succeed. Per the design gate's ordering rule, this story's wire does not freeze until Story 7.4 concludes.

### Story 7.3: Always let go

As the client host,
I want the MCP adapter's teardown paths to release the Chat ID under a bounded, testable lifecycle contract,
So that the polite exits stop leaving names reserved by accident.

**Acceptance Criteria:**

**Given** a host that SIGTERM/SIGINTs the MCP child, **When** the signal arrives, **Then** the adapter completes the session release before exiting (retro A8) — one shared, bounded shutdown operation that stops admission and late recovery, coordinates pending auth/bind, prevents late token publication, and releases the resulting session when the server is reachable; repeated close/SIGTERM/SIGINT paths join the same operation. On timeout or unreachable server, the state is recorded as failed/unknown and the process exits under the declared deadline.

**Given** stdin closing while the FIRST authentication/bind is still pending, **When** the shutdown release runs, **Then** it cannot be followed by a later bind assigning a token the release already released (retro A9 — derived from source, not reproduced), and the bind-after-shutdown race is closed and pinned by a test. Out of scope, stated honestly: SIGKILL, OOM kills, power loss, and a dead remote peer — those are exactly Story 7.4's subject.

### Story 7.4: The automatic recovery design

As the builder,
I want a design round-table for automatic unattended crash recovery,
So that the recovery question is answered by a ratified design or a recorded refusal.

**OUTCOME (2026-10-28): RECORDED REFUSAL — the deliverable.** All four named candidates fail the Two-Tab Co-Tenancy bar (the socket design's "ECONNREFUSED is the death certificate" premise is refuted from Apple XNU sources: a LIVE listener can get it when its accept queue is full or allocation fails; the lease and self-report refusals are confirmed). The supported recovery stays the explicit `agent-room session replace`; no server surface changed, and Story 7.2's design work is un-held. Narrow prior delegation to a named supervisor is RECORDED as a possible NEW policy — ratifiable only with demonstrated Two-Tab exclusion and the five-part honest-consent shape in the record. One vendor of record (codex `gpt-6.1-sol[ultra]`; the agy seat quota-exhausted — substitution disclosed per the playbook). Verdict: `docs/implementation/reviews/epic-7-a2-recovery-design-codex.md`; the record: `docs/implementation/spec-7-4-the-automatic-recovery-design.md`.

**Acceptance Criteria:**

**Given** the recorded blocker (identifying the rightful successor process needs session-resume ownership evidence the Actor key alone cannot provide — retro A2), **When** the round-table concludes, **Then** a design exists (or a reasoned refusal — the default baseline) that names the ownership evidence, the trust boundary it crosses, the exact server surface, the replay/crash behavior, and the consent model. It pre-commits to NOTHING: no mechanism, no schema, no implementation. The falsification bar every candidate must clear is the Two-Tab Co-Tenancy Test — two live processes sharing one `${PLUGIN_DATA}` are indistinguishable from a crash-restart pair to any disk-token scheme, so a disk-only recovery secret FAILS by construction. Named candidates for the table: a disk-only one-time recovery secret (fails co-tenancy); a kernel-enforced liveness probe (a `node:net` Unix domain socket in `${PLUGIN_DATA}` whose `ECONNREFUSED` is the OS's own death certificate, paired with a server-bound one-time recovery ticket — the only zero-dependency candidate that separates the two worlds, to be judged on `sockaddr_un` path limits, startup unlink races, SIGSTOP false-dead detection, and the Spine amendment a non-interactive resume transition requires); a shortened lease TTL with a background heartbeat (refused by prior recorded decision); and self-reported process lineage (refused — unverifiable over Remote Mode). The consent question is explicit: narrow prior delegation to a trusted supervisor is a possible NEW policy to be ratified, never a silent rename of an automatic takeover.

### Story 7.5: Instruments that recompute

As the release owner,
I want the flight kit to measure and verify by computation,
So that evidence is judged by arithmetic, not by string search.

*(Provenance, per the design gate: A4 and A10 are open RELEASE-ledger items the retro recorded without assigning to v0.3 — Epic 7 adopts them as a visible scope choice. A13's rule applies to any instrument introduced here before it is relied on.)*

**Acceptance Criteria:**

**Given** a REL-1-style run, **When** freshness is observed, **Then** the observer ships as a Flight Kit script (retro A4) — the measurement the AC asks for is no longer re-invented per run.

**Given** the REL-1 evidence bundle, **When** `rel1-verify-evidence.mjs` runs, **Then** it RECOMPUTES the freshness arithmetic and parses the recording's own metadata instead of grepping transcripts for substrings (retro A10), while staying a structural verifier — it still never edits evidence, and a first transmission is distinguishable from an idempotent replay in what it checks.

### Story 7.6: Where the heap goes

As the builder,
I want the retained-state diagnostic's rise explained,
So that "rising 0.65%/hour" becomes a fixed defect, a recorded non-defect, or an honest INCONCLUSIVE.

*(Per the design gate: the disposition may be INCONCLUSIVE — a finite trace may establish neither a leak nor a bound — and an inconclusive outcome states the unresolved question and the follow-up instead of claiming bounded behavior. FR-13's settled-window RSS gate is untouched; this story works only on the diagnostic and any concrete retainer it can prove.)*

**Acceptance Criteria:**

**Given** attempt 6's `--trace-gc` capture and the soak harness, **When** the retained-state rise is profiled against the post-reconnect cycle, **Then** the finding is dispositioned with calibrated coverage: a repair lands if it is a defect; a bounded-behavior record lands with the measurement that proves the bound; or the outcome is INCONCLUSIVE with the next measurement named — and the provisional threshold is either calibrated or its provisionality is restated.
