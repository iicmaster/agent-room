---
title: 'Store schema v2 — rooms & the durable log'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: 'df015f6165c2685156523c7b9635ae2a4f047601'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/docs/implementation/epic-1-context.md'
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/implementation/spec-1-1-runtime-foundation-single-limits-module.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** no v2 store exists. v0.1's `server/database.mjs` uses a global AUTOINCREMENT seq (not room-local), has no room kind or DM pair key, no fingerprint-based actors, and no append-only guarantee — the conversation verbs of Stories 1.3–1.8 have nothing durable and contiguous to stand on.

**Approach:** build the schema-v2 store as a NEW module (`server/store/room-log.mjs`) beside the untouched v0.1 store: rooms (broadcast/direct + canonical `direct:<fp_min>:<fp_max>` pair key), a per-room contiguous append-only message log keyed (room_id, seq), idempotent sends by (actor fingerprint, room, client_message_id), and protocol-level DM privacy at the store boundary. The v0.1 daemon and `database.mjs` stay untouched; a v1 database file is refused, not migrated (migration is Epic 2).

## Boundaries & Constraints

**Always:** SQLite STRICT tables, WAL, `synchronous=FULL`, foreign keys ON, busy_timeout 5000, `wal_autocheckpoint=1000` preserved (assert by test, not convention); sequences room-local, contiguous from 1, assigned inside the same `BEGIN IMMEDIATE` transaction as the insert (no deferred index work on the commit path — the p95 ≤150 ms envelope by construction, executable check stays Story 4.4); idempotency tuple (actor fingerprint, room, client_message_id) checked before insert — matching payload returns the original message, differing payload throws `client_message_id_conflict` (codes from constants.mjs); messages append-only — the store module contains no UPDATE or DELETE on messages; reply targets resolve room-locally against (room_id, seq); room ids are opaque base64url; fingerprints validated as `sha256:<64 lowercase hex>`; all bounds imported from constants.mjs; every error name from `PUBLIC_ERRORS`/constants.

**Block If:** a v1 (user_version=1) database file must be migrated or overwritten in this story (never — refuse with `database_schema_unsupported`, Epic 2 owns migration); the per-room counter cannot be made gap-free under concurrency without violating single-writer (halt with evidence).

**Never:** no HTTP/api/core/MCP wiring (Stories 1.3/1.7); no realms table or realm_id (Story 1.3 owns realm bootstrap — rooms simply have no realm column yet); no chat_id_claims table (Story 1.5); no changes to `server/database.mjs`, `server/roomd.mjs`, or any v0.1 behavior or test; no migration code; no ORM/heavy query builders — plain `node:sqlite` only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| contiguous seq | fresh v2 db, two sends to one room | seq 1 then 2 — room-local, gap-free; second room independently starts at 1 | No error expected |
| idempotent resend | same (fingerprint, room, client_message_id), matching payload | original committed message returned, duplicate=true, no new row | No error expected |
| idempotency conflict | same tuple, different text | no new row | `client_message_id_conflict` |
| crash before commit | child process begins txn, inserts, exits without COMMIT (SIGKILL) | reopened store: message absent, seq not consumed | No error expected |
| store guarantees | opened db | STRICT tables, WAL, synchronous=FULL, fk ON, autocheckpoint 1000 | assertions fail otherwise |
| append-only | store module source | no UPDATE/DELETE on messages (static test); reopen after reads leaves bytes unchanged | test fails otherwise |
| DM privacy | direct room A+B, third fingerprint | post → `actor_not_member`; read → `actor_not_member` | denied both directions |
| pair key | open direct room (fpA, fpB) then (fpB, fpA) | same canonical room id `direct:<min>:<max>` lexicographic; (fpA, fpA) allowed | No error expected |
| v1 database | open store on a user_version=1 file | refused, file untouched | `database_schema_unsupported` |
| reply room-local | reply_to_seq of a seq that exists only in another room | refused | `reply_room_mismatch` |

</intent-contract>

## Code Map

- `server/database.mjs` -- v0.1 store, DO NOT MODIFY: `openRoomDatabase` (line 274), pragma discipline to mirror (`configureConnection` line 125: WAL/FULL/fk/busy 5000/autocheckpoint 1000), `withImmediateTransaction` (line 160) as the txn pattern, `ensureSchema` user_version gate (line 228), global-seq reply bug at line 451 (fixed by room-local (room_id, seq) lookup).
- `server/store/room-log.mjs` -- NEW: `openRoomLog({ dataDir })` → frozen api: `createBroadcastRoom({actorFingerprint, title?})`, `openDirectRoom({actorFingerprints: [a, b]})` (canonical, idempotent by UNIQUE pair_key), `appendMessage({roomId, actorFingerprint, chatId, clientMessageId, text, replyToSeq?})` → `{message, duplicate}`, `readPage({roomId, actorFingerprint, afterSeq, limit})`, `getRoom(roomId)`, `close()`. Database file: same `agent-room.sqlite` name, user_version 2.
- `server/constants.mjs` -- import every bound (MESSAGE_TEXT_MAX, CLIENT_MESSAGE_ID_MAX, TITLE_MAX, READ_PAGE_MAX) and error names; no new numbers here.
- `server/keys.mjs` -- fingerprint format reference (`sha256:<64 lowercase hex>`) for validation regex; do not import private-key functions.
- `tests/store.test.mjs` -- NEW: every matrix row; pragma assertions via `PRAGMA table_list`/`journal_mode`; crash test spawns a real child process (SIGKILL mid-transaction); static append-only scan mirrors tests/constants.test.mjs walker style.

## Tasks & Acceptance

**Execution:**
- `server/store/room-log.mjs` -- create schema (rooms, direct_members, messages) + operations per Code Map; per-room seq via `COALESCE(MAX(seq),0)+1` inside the append transaction -- the durable log with DM pair keys and store-level ACL.
- `tests/store.test.mjs` -- cover all 10 matrix rows plus pragma/STRICT assertions and the append-only static scan -- AC-level proof, not convention.

**Acceptance Criteria:**
- Given a fresh schema-v2 database, when two sends commit to one room, then seq 1 then 2 room-local contiguous gap-free; rooms carry kind and the canonical pair key.
- Given a resend of the same (Actor, room, client_message_id), when the payload matches, then the original returns; when it differs, then `client_message_id_conflict`.
- Given a crash before commit, when the store recovers, then the uncommitted message is absent and its seq unconsumed.
- Given the store, when inspected, then STRICT/WAL/FULL/autocheckpoint and append-only messages hold by test; a third Actor is denied read and post on a direct room.

## Spec Change Log

## Review Triage Log

### 2026-09-25 — Review pass 1 (4 internal layers + codex-advisor[luna] gpt-5.6-luna)
- intent_gap: 0
- bad_spec: 0
- patch: 31: (high 3, medium 9, low 19)
- defer: 0
- reject: 6
- addressed_findings:
  - `high` `patch` SIGKILL crash test bypassed the real appendMessage path (raw DatabaseSync insert) — real-path instrumentation demanded; interim redesign, superseded by pass 2's blocker fix
  - `high` `patch` concurrent openRoomLog on a fresh file crashed the loser with a raw CREATE error — in-transaction user_version re-read, loser no-ops; busy-retry wrap
  - `high` `patch` getRoom disclosed direct-room pair_key (both fingerprints) to any id-holder — membership-gated for direct rooms
  - `medium` `patch` database_schema_unsupported + invalid_chat_id registered in PUBLIC_ERRORS/status; INTERNAL_ERROR_CODES exported as the declared-once home for internal codes; thrown-codes ⊆ vocabulary static test
  - `medium` `patch` db file pre-created 0600 (no umask window) + -wal/-shm chmod 0600 on open, all three asserted
  - `medium` `patch` raw SQLite errors coded: closed-guard, SQLITE_BUSY→database_busy, version-0-with-tables/NOTADB/CORRUPT→database_schema_unsupported
  - `medium` `patch` two-writer concurrency proof (two connections 1..8 + two child processes 1..12) — gap-free under serialization now exercised
  - `medium` `patch` cursor pagination pinned (strict-greater, order, truncation, past-head); cross-room idempotency scope; chat_id excluded from payload proven by resend-with-different-chatId
  - `medium` `patch` append-only scan whitespace-normalized (multiline mutations caught); schema CHECKs for fingerprint shape + reply_to_seq; realistic v1 fixture built with real v0.1 openRoomDatabase + sidecar-absence
  - `low` `patch` (remaining) membership survives reopen, validation boundaries, openRoomLog guards, schemaVersion reads actual user_version, unpaired-surrogate rejection
- notes: luna (gpt-5.6) verdict FIX-FIRST (2 blockers folded above); rejects = chat-id grammar (matches DR-1 verbatim, Story 1.5 owns uniqueness), C1-control parity with v0.1 text validation, db-symlink TOCTOU (owner-only 0700 boundary, v0.1 pattern), random room-id collision retry (128-bit)

### 2026-09-25 — Review pass 2 (codex-advisor[luna] gpt-6-luna, post-patch)
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 1, medium 0, low 2)
- defer: 0
- reject: 0
- addressed_findings:
  - `high` `patch` pass-1 crash test still killed the child while appendMessage was blocked AWAITING the writer lock (never entered its transaction) — redesigned with a test-only BEFORE INSERT trigger running a slow deterministic recursive CTE so the real appendMessage blocks mid-INSERT inside its own transaction; parent SIGKILLs there; asserts no ack, row absent, seq 1 unconsumed by a fresh real append
  - `low` `patch` generated room ids lacked a positive format test — both creation paths assert 22-char base64url
  - `low` `patch` open-retry (8×25 ms) and room-id entropy (16 bytes) moved to constants (STORE_OPEN_BUSY_RETRY_LIMIT, STORE_OPEN_BUSY_BACKOFF_MS, ROOM_ID_ENTROPY_BYTES)
- notes: gpt-6-luna[max] verified matched per user's seat directive; final state 88/88

## Design Notes

Pair key derivation: sort the two fingerprints lexicographically, `direct:${min}:${max}`; UNIQUE(pair_key) makes `openDirectRoom` idempotent in either argument order; multiple NULL pair_keys (broadcast) are fine under SQLite UNIQUE. Per-room counter: MAX(seq)+1 per room inside BEGIN IMMEDIATE is gap-free because the single writer serializes appends (AD-2). Chat ID is stored on the message at send time (`chat_id` column) — attribution never rewritten later (D13/FR-19). direct_members exists ONLY for direct rooms; broadcast membership is implicit (AD-14), so broadcast append/read needs no membership row.

## Verification

**Commands:**
- `node --test` -- expected: all pass including new tests/store.test.mjs; existing 55 untouched and green.
- `grep -rnE "UPDATE messages|DELETE FROM messages|UPDATE  messages" server/store/` -- expected: no matches (append-only).

## Auto Run Result

Status: done

**Summary:** Schema-v2 store shipped as `server/store/room-log.mjs`: rooms (broadcast/direct + canonical `direct:<fp_min>:<fp_max>` pair key, idempotent by UNIQUE), `direct_members` ACL, and the append-only durable message log keyed `(room_id, seq)` — room-local contiguous sequences from 1 assigned inside `BEGIN IMMEDIATE`; idempotent sends by (fingerprint, room, client_message_id) with matching-resend-returns-original and `client_message_id_conflict`; room-local reply resolution; send-time `chat_id` attribution; v1 files refused untouched (migration = Epic 2). v0.1 store/daemon byte-untouched.

**Files changed:** `server/store/room-log.mjs` (new), `tests/store.test.mjs` (new, 31 tests incl. two-writer concurrency, mid-INSERT SIGKILL, concurrent-opener race), `server/constants.mjs`/`tests/constants.test.mjs` (additive: database_schema_unsupported 500, invalid_chat_id 400, INTERNAL_ERROR_CODES, store-internals constants), plus `docs/implementation/reviews/story-1.2-luna-gpt55.md` + gpt-6-luna audit archived, `.gitignore` lane-state entries.

**Review findings breakdown:** pass 1 (4 internal layers + gpt-5.6-luna) 31 patched / 6 rejected; pass 2 (gpt-6-luna) 3 patched / 0 rejected; 0 deferred; 0 intent gaps; 0 bad_spec.

**Follow-up review recommendation:** true — patched counts high 3 / medium 9+0 / low 19+2, score 3×9+19+3×0+2 = 48 ≥ 5 (high present regardless).

**Verification performed:** `node --test` 88/88 (stable across 8+ consecutive full-suite runs incl. SIGKILL, concurrency, race suites); append-only grep clean; append-only static scan whitespace-normalized; crash test exercises the real appendMessage mid-INSERT via test-only slow trigger (no production hook); `git diff HEAD -- server/database.mjs server/roomd.mjs` empty.

**Residual risks:** same-filename coexistence — `openRoomLog` refuses the v0.1-owned database until Epic 2's migration story lifts the gate; store error codes wire-visible from Story 1.7 must keep using the registered table; the SIGKILL suite is macOS/arm64-proven and inherently the most environment-sensitive test.
