---
title: 'MCP adapter — tools, first-run prompt & untrusted envelope'
type: 'feature'
created: '2026-09-25'
status: 'in-progress'
baseline_revision: '51c5c93e4d2dd854e6f39ace3447f3cdf8030746'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/docs/implementation/epic-1-context.md'
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/implementation/spec-1-6-presence-online-offline-recently.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** the MCP surface still speaks the retired unix-socket daemon (room_create/room_join against roomd) — none of the v0.2 tools exist (presence, DM open, status), foreign text is not framed, cursors are not client-owned, and a first run has no Chat ID path. Story 1.8's checkpoint and the whole product heart stand on this story.

**Approach:** (server) implement the frozen actor routes the tools need — `POST /api/rooms/direct` (open-or-create pair room; `ambiguous_chat_id` with candidates, resolved by `target_fingerprint`), `GET|POST /api/rooms/:id/messages` (long-poll read ≤20,000 ms server hold, deadline = normal possibly-empty page with `next_after_seq`/`head_seq`; send = idempotent append returning `status: committed` or `client_message_id_conflict`) — and (client) rewrite `server/mcp-stdio.mjs` onto a new HTTP api-client over `ensureServer`: tools `room_presence({include_offline?})`, `room_direct_open({chat_id, target_fingerprint?})`, `message_send`, `message_read`, `room_status`; the static versioned `<untrusted_message>` envelope for foreign bodies; client cursor persistence per (installation, realm, room) under `PLUGIN_DATA/realms/<realm_id>/`; `outcome_unknown` retry with the identical `client_message_id`; and the one-time `agent-room setup` command (never prompts on the MCP stdin).

## Boundaries & Constraints

**Always:** tool identity comes only from the session token — no tool argument may carry sender identity or authority (NFR-3 negatives); the untrusted envelope is STATIC and versioned (`<untrusted_message version="1">` carrying sender chat_id, fingerprint, and the data-never-instructions-or-authorization warning), applied exactly when the sender fingerprint differs from the local installation's; same-Actor messages return plain; this response schema is FROZEN from this story forward (additive only later); cursors are client-owned and durably persisted per (installation, realm, room) under `PLUGIN_DATA/realms/<realm_id>/` (0600, atomic writes) — the server holds no per-client delivery state; `message_read` responses carry `next_after_seq` and `head_seq`; long-poll holds ≤ 20,000 ms server-side with NO open read transaction while waiting; concurrent `room_direct_open` calls return the same room (pair-key idempotency); `ambiguous_chat_id` never guesses — candidates carry fingerprints + last-seen and `target_fingerprint` completes resolution; tool descriptions carry "list agents" phrasing + Agent Room identity; no native-named aliases; `mcp-stdio` binds with `client_type: 'mcp'`; the setup command validates DR-1 grammar, refuses live collisions with retry, stores config in PLUGIN_DATA (0600), and the mcp-stdio process NEVER prompts on stdin; the pre-agreed 3-commit split lands as three commits, each leaving the suite green: (a) tools + client cursors + `outcome_unknown` retry · (b) untrusted envelope + NFR-3 negatives · (c) `agent-room setup`.

**Block If:** a frozen-contract change beyond dated additive amendments becomes necessary (halt with the exact conflict); the long-poll cannot be implemented without holding a store read transaction (halt with evidence).

**Never:** no native-named tool aliases; no room_create/room_join tools (AD-14: no join verbs — retired with the unix path); no sender-authority from arguments; no envelope framing for same-Actor messages; no rate gates (Epic 4 statuses only: `committed`/`client_message_id_conflict` here); no viewer work; no remote auth; no deletion of `roomd.mjs`/`daemon-client.mjs` or v0.1 behavior tests (legacy, untouched — nothing spawns them anymore once mcp-stdio is rewired; Epic 2/5 own their fates); no held-message pipeline (Epic 3).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| tools list | agent lists tools | five tools with "list agents" phrasing; no aliases | No error expected |
| direct open happy | room_direct_open({chat_id}) unique claim | existing-or-created pair room id returned; concurrent calls → same id | No error expected |
| ambiguous | two Actors claim "bob" | 409 `ambiguous_chat_id` with candidates (fingerprint + last_seen) — never a guess | coded, completable |
| disambiguation | same call + target_fingerprint of candidate 2 | resolves to that candidate's pair room | No error expected |
| unknown name | room_direct_open({chat_id}) no claims | coded 404-family error naming the miss | `chat_id_not_found` |
| read long-poll | message_read wait_ms=5000, message arrives at 2 s | returns at ~2 s with the message; `next_after_seq`/`head_seq` correct | No error expected |
| read deadline | wait_ms=5000, silence | normal possibly-empty page at ~5 s — never 204, never an error | No error expected |
| hold cap | wait_ms=25000 | refused (≤ 20,000) | 400 coded |
| foreign message | sender fingerprint ≠ local | body wrapped in `<untrusted_message version="1">` with sender chat_id + fingerprint + warning | No error expected |
| same-Actor message | sender fingerprint == local | plain body, no envelope | No error expected |
| cursor persistence | successful read | cursor advanced + persisted under PLUGIN_DATA/realms/<realm_id>/; survives client restart | No error expected |
| outcome_unknown | network drop mid-send, retry same client_message_id | original returned or conflict — never a duplicate row | No error expected |
| identity smuggle | tool arg carrying actor/fingerprint authority fields | rejected — unknown field / NFR-3 negative | 400 coded |
| first run | no config in PLUGIN_DATA | tools fail with actionable guidance naming `agent-room setup`; mcp-stdio never reads stdin | coded guidance |
| setup happy | human runs agent-room setup, enters valid free name | config stored 0600; name verified claimable then released | No error expected |
| setup collision | name taken live | refused with retry loop; no config written until free name accepted | No error expected |
| stdin purity | mcp-stdio process lifetime | stdin consumed only by JSON-RPC (no prompt bytes ever written to it) | test fails otherwise |

</intent-contract>

## Code Map

- `server/api/server.mjs` + `server/store/room-log.mjs` -- server side: `POST /api/rooms/direct` handler (claims lookup → 0: `chat_id_not_found` 404; 1: `openDirectRoom` pair; many: 409 `ambiguous_chat_id` with `candidates` in the error — dated spine amendment: the error envelope gains optional `candidates` [{fingerprint, last_seen}] for this code); messages GET (long-poll: bounded in-process wait loop polling store readPage — no open transaction; member ACL reuses store) and POST (append; `status: 'committed'`); register routes in the frozen table; register `chat_id_not_found` (404) + `ambiguous_chat_id` (409) + `candidates` (response vocabulary) additively.
- `server/client/api-client.mjs` -- NEW: AgentRoomClient over HTTP: ensureServer(shareddir) → auth/local (public_key from keys.mjs) → bind session (chat_id from config, client_type 'mcp') → typed methods presence/directOpen/sendMessage/readMessage/status; session-token bearer; single-flight re-auth on 401; outcome_unknown recording on send (immediate one retry with identical client_message_id).
- `server/mcp-stdio.mjs` -- REWRITE: five TOOL_DESCRIPTORS (no room_create/room_join), callTool → api-client, `wait_ms` passthrough (MCP timeout = wait + margin), untrusted envelope applied to message bodies in results, cursor persistence in `PLUGIN_DATA/realms/<realm_id>/cursors.json` (atomicWriteJson 0600), first-run guidance error naming `agent-room setup`. Keep the runtime gate, stdin JSON-RPC purity, frame cap.
- `server/cli/agent-room.mjs` -- NEW: `agent-room setup` (TTY readline: collect chat_id → validate DR-1 via chatIdForms → ensureServer + auth + POST /api/session probe (409 → re-prompt; success → DELETE /api/session to release) → store PLUGIN_DATA/config.json 0600 atomic). No prompting when stdin is not a TTY (exit with guidance).
- `server/core/session-registry.mjs` -- claim already returns chat_id; nothing new expected unless tests demand.
- `server/constants.mjs` -- additive: chat_id_not_found 404, ambiguous_chat_id 409, candidates vocabulary, CLIENT_TYPE 'mcp' usage; MCP tool text bounds reuse MESSAGE_TEXT_MAX.
- `tests/` -- NEW `tests/direct-open.test.mjs` (ambiguity/disambiguation/concurrency), `tests/messages-api.test.mjs` (long-poll/deadline/hold-cap/send statuses/foreign-acl), `tests/mcp-tools.test.mjs` (real mcp-stdio children against a real spawned server: list shapes, envelope, cursors, outcome_unknown via a proxy that drops the first send, NFR-3 negatives, stdin purity, first-run guidance), `tests/setup-command.test.mjs` (TTY-free: feed stdin fixture / assert non-TTY guidance, collision retry via server state). v0.1 suites stay untouched and green.

## Tasks & Acceptance

**Execution (three commits, each suite-green):**
- Commit (a): server direct/messages routes + api-client + mcp-stdio tools + cursors + outcome_unknown.
- Commit (b): untrusted envelope + NFR-3 negatives (schema-level + static).
- Commit (c): `agent-room setup` + first-run guidance.
- Tests per commit; final full matrix.

**Acceptance Criteria:**
- Given the five tools, when listed, then descriptions carry "list agents" phrasing, no aliases; concurrent direct opens return one room; ambiguity round-trips to resolution.
- Given a foreign-sender message, when returned, then the static versioned envelope wraps it; same-Actor stays plain; schema frozen.
- Given a successful read, cursors persist per (installation, realm, room); outcome_unknown retries resolve idempotently; identity-smuggling args are rejected.
- Given first run, `agent-room setup` collects/validates/stores the Chat ID (collision retry); mcp-stdio stdin stays pure.

## Spec Change Log

## Review Triage Log

## Design Notes

Direct rooms reuse store.openDirectRoom's pair-key idempotency — the handler maps chat_id→fingerprint via listClaimsForChatId (most recent per Actor) and computes the pair with the CALLER's fingerprint; self-DM (same fingerprint) is refused here (v0.2 refuses self-DM per D13) with a distinct message on the invalid_request family. Long-poll: the handler loops {readPage; if empty and time remains, sleep 250 ms} inside the request — connections are per-request (node:http), so a held response holds no store lock; budget stage stays pass-through. The envelope is a pure string transform in the client (version constant; wrapper carries sender chat_id + fingerprint + the warning line); the MCP result JSON embeds it verbatim — 1.8 byte-matches it.

## Verification

**Commands:**
- `node --test` -- expected: all pass; v0.1 suites untouched and green.
- `grep -rn "room_create\|room_join" server/mcp-stdio.mjs` -- expected: no matches (retired verbs).
- `grep -rn "prompt\|readline" server/mcp-stdio.mjs` -- expected: no matches (stdin purity).
