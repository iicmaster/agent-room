---
title: 'Chat ID connect, rename & durable claims'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: 'ec5a10e008d2dfb2a64121cb723ad35df5e921c4'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/docs/implementation/epic-1-context.md'
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/implementation/spec-1-4-local-bootstrap-local-session-auth.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** sessions cannot name themselves. Story 1.8's two participants need stable, distinct, renameable Chat IDs; the offline-discovery contract (FR-5/FR-21) needs the durable `chat_id_claims` index; nothing yet enforces DR-1's Chat ID grammar or the live-uniqueness rule.

**Approach:** add the session connect surface — an actor-class route `POST /api/session` (frozen table) that binds the authenticated Actor to a Chat ID for the session's lifetime — plus `PATCH /api/session` (rename, immediate), a server-resident live-session registry (ephemeral, heartbeat-driven), and the durable `chat_id_claims(chat_id, actor_fingerprint, last_seen_at)` index written on connect/rename/heartbeat, pruned at 7 days. Live-name uniqueness is enforced among currently-connected sessions with explicit refusal (no suffixing); multiple Actors may hold durable claims on one name (ambiguity data for `room_direct_open`).

## Boundaries & Constraints

**Always:** DR-1 grammar — 1–32 chars `[A-Za-z0-9_.-]`, case-insensitive comparison/uniqueness (normalized form = lowercase for uniqueness checks; the display form preserves case); live collision refused with an explicit coded error — never suffixed, never auto-mangled; rename is immediate (old name releasable in the same instant) and never rewrites history (messages keep send-time Chat IDs — store already does); claims rows are durable across restart (WAL SQLite), keyed (chat_id_normalized, actor_fingerprint) with last_seen_at updated on connect/rename/heartbeat; prune deletes claim rows whose last_seen_at is older than CLAIMS_TTL_MS (7 days default, single constant — operator-tunable via a startServer option); the live-session registry is server-resident and ephemeral (restart clears it; rebuilds as sessions reconnect) — one row per live session (chat_id, actor_fingerprint, connected_since, last_seen); a session releasing its name (disconnect/DELETE /api/session) frees it for the next claimer immediately; every mutation inside `BEGIN IMMEDIATE`; bounds and statuses imported from constants; no state change on any rejection.

**Block If:** making live-uniqueness atomic across concurrent claims of the same name requires schema outside the additive v2 policy (halt with the design conflict).

**Never:** no presence list or offline-recently bucket (Story 1.6 — this story only persists the claims rows it needs); no DM opening or `ambiguous_chat_id` resolution (Story 1.7 consumes the claims index); no heartbeats yet (Story 1.6 owns cadence — claims last_seen_at updates happen on connect/rename and via an exported registry touch() the next story calls); no ban/allowlist; no viewer; no MCP; no remote-auth routes; no v0.1 file changes; chat_id never accepted from a request without a valid session (actor identity always from the token, never the body).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| connect happy path | POST /api/session {chat_id}, valid session | 200; live registry row + durable claim row (session's fingerprint, now) | No error expected |
| live collision | second live session claims same name (any case) | refused, explicit coded error, no suffixing; first holder unaffected | `chat_id_taken` 409 |
| case-insensitive | "Alice" live, "alice" claims | refused (same normalized name) | `chat_id_taken` 409 |
| grammar | chat_id with invalid char / empty / 33 chars / non-string | refused | 400 coded |
| rename happy | PATCH /api/session {chat_id: new} | immediate; old name freed; new claim row upserted; live registry updated | No error expected |
| rename onto taken | rename to a live-colliding name | refused; original name retained | `chat_id_taken` 409 |
| disconnect frees | DELETE /api/session | live row removed; name immediately claimable by another session; claim row stays (durable, for ambiguity) | No error expected |
| durable across restart | connect, restart server, inspect store | claim row survives (same chat_id + fingerprint); live registry empty | No error expected |
| multiple Actors one name | Actor A claims "bob", disconnects; Actor B claims "bob" | two durable claim rows on "bob" (ambiguity data); live only B | No error expected |
| prune | claims rows older than 7 days | deleted on prune cycle; recent rows kept | No error expected |
| no session | connect/rename/delete without valid token | 401; zero state change | coded |
| unknown field | body with non-vocabulary field | 400 rejected not ignored | coded |

</intent-contract>

## Code Map

- `server/api/routes.mjs` -- register `POST /api/session` + `PATCH /api/session` + `DELETE /api/session` (actor class; frozen names; requestFields: chat_id for POST/PATCH, none for DELETE) — all three already in AD-8's table.
- `server/core/session-registry.mjs` -- NEW live-session registry (in-memory Map keyed by session token digest → {chatId, normalized, actorFingerprint, connectedSince, lastSeen}); claim/release/rename/touch; the heartbeat story (1.6) calls touch().
- `server/store/room-log.mjs` -- additive: `chat_id_claims` table (chat_id_normalized TEXT, actor_fingerprint TEXT, chat_id_display TEXT, last_seen_at TEXT; PRIMARY KEY (chat_id_normalized, actor_fingerprint)) via the IF NOT EXISTS convergence pattern; ops `upsertChatIdClaim`, `listClaimsForChatId(normalized)`, `pruneChatIdClaims(olderThanMs, now)` — claim writes join the caller's transaction or use their own BEGIN IMMEDIATE.
- `server/api/server.mjs` -- wire the three handlers to the registry + store; DELETE releases the live name and ends the session (registry removal; token invalidation optional — document choice); prune runs on boot and lazily (constant interval) with CLAIMS_TTL_MS default.
- `server/constants.mjs` -- CHAT_ID_MAX exists (32); add CHAT_ID_PATTERN (derived), CLAIMS_TTL_MS (7 d), PRUNE_INTERVAL_MS; register `chat_id_taken` (409) + `invalid_chat_id` already exists (400).
- `tests/session-routes.test.mjs`, `tests/chat-id-claims.test.mjs` -- NEW: full matrix with real spawned servers + real keypairs/sessions from the 1.4 path; restart-durability via stop/respawn; prune with injectable clock.

## Tasks & Acceptance

**Execution:**
- `server/core/session-registry.mjs` + store claims ops -- the connect/rename/release machinery -- distinct participants with durable ambiguity data.
- `server/api/server.mjs` + routes -- three handlers wired through the 1.3 pipeline (actor class, real verifier) -- the first sessioned actor routes.
- constants + tests -- matrix rows executable -- AC-level proof.

**Acceptance Criteria:**
- Given a live session holding a Chat ID, when another session claims the same name (any case), then explicit refusal — no suffixing; rename immediate; history keeps send-time names.
- Given connect/rename, when claims update, then (chat_id, fingerprint, last_seen_at) durable across restart, multiple Actors per name allowed, prune at 7 days (tunable).
- Given a proposed Chat ID, when validated, then DR-1: 1–32 chars `[A-Za-z0-9_.-]`, case-insensitive uniqueness.

## Spec Change Log

### 2026-09-25 — review decision (documentation-only)
- POST /api/session on an already-bound session with a DIFFERENT free name swaps immediately (rename-equivalence); exact re-bind is idempotent. The spec was silent; both readings were defensible; the permissive reading matches PATCH's immediacy and is now documented + HTTP-tested. Known-bad state avoided: silently divergent POST/PATCH semantics. KEEP: both verbs route through one atomic bind.

## Review Triage Log

### 2026-09-25 — Review pass 1 (4 internal layers + codex-advisor[luna] gpt-6-luna)
- intent_gap: 0
- bad_spec: 0
- patch: 19: (high 2, medium 4, low 13)
- defer: 3: (low 3)
- reject: 5
- addressed_findings:
  - `high` `patch` touch() was memory-only — an actively-heartbeating session's durable claim would go stale and be pruned while live — touch now persists claim recency in the same operation (pre-wired touchSession), tested; live-touched claims survive the 7-day window
  - `high` `patch` live registry had no eviction — dead sessions squatted Chat IDs until restart — lease sweep (SESSION_TTL_MS) on claim frees abandoned names, memory-only; durable rows kept for ambiguity
  - `medium` `patch` last_seen_at could regress (non-monotonic upsert, two clocks) — max() upsert, one injectable clock across connect/rename/touch
  - `medium` `patch` interval prune + failure containment never executed — prune-interval override, injectable prune seam, mid-run prune test, one-stderr-line containment test, TTL/2 clamp
  - `medium` `patch` grammar gate + chat_id_taken message duplicated (wire-drift risk) — shared chatIdForms/CHAT_ID_INVALID_MESSAGE in constants, both call sites cite
  - `medium` `patch` claimsTtlMs had no operator surface — AGENT_ROOM_CLAIMS_TTL_MS env on the direct launch with strict validation + warning fallback
  - `low` `patch` (remaining) chat_id echo in responses (incl. case-only re-bind), POST-swap documented+tested, missing-vs-malformed field convention, PATCH-as-first-verb test, last_seen advance via live path, cutoff/now finite guards, divergent claims-table column check, owned-registry clear on close, zero-state boundary documented (auth sliding refresh accepted), prune-vs-live-holder defensive test
- notes: gpt-6-luna[max] matched; rejects = ISO-format schema CHECK (runtime guard covers all store-op callers), claims cardinality bound (loopback-only exposure; budgets land Epic 4 — deferred), R4 durable-index-uniqueness reading (affirmatively rejected by design), R5 operator-surface reading resolved by the env patch, live-observability surface (409-as-evidence, by design); defers = rename-churn cardinality bound before remote access (Epic 4 gate), AGENTS.md module map (template-managed), heartbeat cadence itself (Story 1.6)


## Design Notes

Normalized chat_id (lowercase) keys uniqueness and claims; the display form rides alongside (chat_id_display) so FR-19's case preservation needs no re-derivation in 1.6/1.7. DELETE /api/session ends the session: registry row removed; the token is left to expire naturally (12 h sliding, harmless — it re-authenticates to a nameless session; connecting again re-claims). Claims upsert on connect/rename means the index always holds the LATEST claim per (name, actor) plus historical (name, actor) pairs — ambiguity data. Heartbeat: Story 1.6 calls registry.touch(sessionToken) which also refreshes the claim row's last_seen_at; this story exposes touch() but nothing calls it yet (documented, not dead code).

## Verification

**Commands:**
- `node --test` -- expected: all pass; 172 pre-existing untouched.
- `grep -rn "suffix\|rename.*history" server/core/session-registry.mjs` -- expected: refusal paths only, no rewrite logic.

## Auto Run Result

Status: done

**Summary:** Sessions are now distinct named participants: POST/PATCH /api/session atomically bind a Chat ID (DR-1 grammar, case-insensitive live uniqueness, explicit `chat_id_taken` refusal — never suffixed; display case preserved via normalized+display columns), DELETE frees the name immediately while the durable claim row persists, and the `chat_id_claims` index (normalized, fingerprint, display, last_seen_at) survives restart, holds ambiguity rows (multiple Actors per name), prunes at the operator-tunable 7-day TTL (env + option), and is kept fresh by a durable touch hook (the Story 1.6 heartbeat pattern). Live rows evict on a session-TTL lease so dead sessions never squat names.

**Files changed:** `server/core/session-registry.mjs` (new), `tests/chat-id-claims.test.mjs` + `tests/session-routes.test.mjs` (new, 31+18 tests), `server/store/room-log.mjs` (additive: claims table + 3 ops + column verification), `server/api/server.mjs`/`routes.mjs`/`session.mjs`, `server/constants.mjs` (chat_id_taken 409, shared chatIdForms, claims constants); `tests/constants`/`api-contract`/`api-host` extended additively.

**Review findings breakdown:** 19 patched (high 2, medium 4, low 13), 3 deferred, 5 rejected; 0 intent gaps; 0 bad_spec (1 documented decision: POST-swap rename-equivalence).

**Follow-up review recommendation:** true — patched high 2 / medium 4 / low 13, score 3×4 + 13 = 25 ≥ 5 (high present regardless).

**Verification performed:** `node --test` 222/222 (3 consecutive runs; 172 pre-1.5 suites untouched); real spawned-server matrix incl. restart durability, lease eviction, prune containment, env override children; injectable-clock prune/lease/touch rows; v0.1 diffs empty.

**Residual risks:** rename churn is age-bounded but not cardinality-bounded until Epic 4's budgets (loopback-only exposure, deferred); heartbeat cadence itself is Story 1.6 (touch pattern shipped + tested); timing-based clamp/mid-run-prune tests use bounded real-clock polling (deterministic in practice).
