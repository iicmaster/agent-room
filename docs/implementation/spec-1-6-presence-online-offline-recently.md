---
title: 'Presence — online & offline-recently'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: 'd9095f09516a0d0909537ab7d5cbb5c3340d3650'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/docs/implementation/epic-1-context.md'
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/implementation/spec-1-5-chat-id-connect-rename-durable-claims.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** sessions cannot see who is addressable. The heart of the product (FR-5) is the presence list: who is online now, and who was recently seen; without it, Chat IDs are unguessable and DMs (1.7/1.8) have no discovery path.

**Approach:** implement `GET /api/presence` (actor class, frozen route) over the live-session registry: one row per live Session (chat_id, client_type, connected_since, last_seen, actor fingerprint), TTL 180 s with liveness refreshed by any authenticated request; an `include_offline` query flag adds a separately-labeled offline-recently group built from the durable claims index (last seen within 24 h, surviving restart); heartbeats: any authenticated actor request refreshes the session's liveness (touch), making dedicated heartbeat pings unnecessary this story — the 60 s ±10% jitter heartbeat CADENCE belongs to the client adapter (1.7) and is only a constant here. Client type: the connecting session declares it at bind time (additive `client_type` request field, values validated against a small closed set) — v0.1's MCP-client-derived naming is retired.

## Boundaries & Constraints

**Always:** presence reads require a valid session (actor class); the response separates `online` and `offline_recently` groups (explicitly labeled — never implying unenrollment); online = live registry rows within TTL (stale rows evicted on read/sweep, lease discipline from 1.5); offline-recently = claim rows with last_seen within OFFLINE_RECENTLY_WINDOW_MS (24 h) EXCLUDING currently-online Actor fingerprints, deduplicated by Actor fingerprint (one row per Actor: most recent claim) and never listing the reading session's own Actor in offline group; liveness refresh: every authenticated actor/pre-auth request calls touch for the requesting session (sliding both the auth TTL and presence liveness — one mechanism); viewer and daemon activity NEVER create or refresh presence (the viewer has no session; the server's own work touches nothing); an unreachable server is reported unreachable by the CLIENT side (connection error surfaces as a connection failure — there is no "everyone offline" response shape anywhere); every timestamp from the one injectable clock; bounds/statuses from constants; rejections change no state beyond the accepted sliding-refresh (documented 1.5 boundary).

**Block If:** presence rows cannot be assembled without schema outside the additive policy (halt with evidence).

**Never:** no heartbeat timer in the server (cadence is client-side; server only sweeps); no SSE/events stream (Epic 5 owns live updates; this story is request/response only); no DM opening or ambiguous resolution (1.7); no viewer changes; no MCP changes; no remote-auth; no v0.1 file changes; offline-recently NEVER lists an Actor that is online (no double-listing across groups).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| online row shape | two connected sessions with client types | GET /api/presence → online group: one row per Session (chat_id display, client_type, connected_since, last_seen, fingerprint) | No error expected |
| liveness refresh | any authenticated request by a session | its last_seen advances (touch); TTL 180 s sliding | No error expected |
| TTL expiry | session silent past 180 s (injectable clock) | its row drops from online (lease sweep); claim row persists | No error expected |
| include_offline | flag set, Actor last seen 2 h ago, not connected | offline_recently group contains it (labeled), online group does not | No error expected |
| offline window boundary | last seen exactly 24 h ago vs 24 h + 1 ms | in-group at exactly 24 h, out beyond | No error expected |
| no double-listing | Actor online AND claimed | appears in online only | No error expected |
| restart survival | connect, disconnect, restart, include_offline | offline-recently still lists it (claims index) | No error expected |
| viewer isolation | viewer-token requests (Epic 5 shape) never registered | presence untouched by any non-session activity | test fails otherwise |
| unreachable server | client dial to dead port | connection error — never a 200 with empty presence | coded client-side |
| no session | presence read without token | 401; zero state change | coded |
| unknown field | include_offline misspelled or extra body | 400 rejected (query allowlist) | coded |
| client_type | bind with client_type "mcp" / invalid value | accepted from closed set / refused 400 | coded |

</intent-contract>

## Code Map

- `server/api/routes.mjs` -- register `GET /api/presence` (actor class; query allowlist: include_offline boolean); add `client_type` to the session-bind request fields (additive, spine amendment dated: client_type joins the request vocabulary — closed set).
- `server/core/session-registry.mjs` -- bind gains clientType (validated closed set: 'mcp' | 'cli' | 'api' — additive set constant); presence assembly helper `presenceSnapshot({ includeOffline, now, claimsReader })` returning {online[], offline_recently[]} — pure function over registry + claims.
- `server/api/server.mjs` -- handler for GET /api/presence (assembles snapshot; exclude own Actor from offline; dedupe by fingerprint most-recent); authenticated-request liveness: the auth stage already slides the auth TTL — extend the actor-class post-auth path to call registry.touch (persist hook wired, from 1.5's pattern) so every authenticated request refreshes presence liveness; GET /api/status (frozen route, actor class) registered too: {realm_id, version, broadcast_room_id} — FR-21 needs it and 1.8's checkpoint consumes it (additive: broadcast_room_id joins response vocabulary via dated spine amendment; realm_id + version already added 2026-09-25).
- `server/store/room-log.mjs` -- additive `recentClaims(windowMs, now)` (claims within window, most-recent per (normalized) — reuse listClaimsForChatId? no — new bounded query by last_seen_at) — offline source.
- `server/constants.mjs` -- PRESENCE_TTL_MS (180 s) exists as heartbeat TTL; OFFLINE_RECENTLY_WINDOW_MS (24 h) exists; CLIENT_TYPES closed set; additive code if needed (prefer existing).
- `tests/presence.test.mjs` -- NEW: full matrix with real spawned servers, two+ sessions with distinct keypairs, injectable clocks for TTL/window boundaries, restart rows, viewer-isolation (viewer-verifier requests), unreachable-client dial row.

## Tasks & Acceptance

**Execution:**
- `server/core/session-registry.mjs` -- clientType on bind + presenceSnapshot assembly -- the read model over liveness.
- `server/api/server.mjs` + routes -- presence + status handlers; authenticated-request touch wiring -- FR-5's surface.
- `server/store/room-log.mjs` -- recentClaims -- offline source.
- constants + spine amendment (client_type, broadcast_room_id) + tests -- matrix executable.

**Acceptance Criteria:**
- Given sessions with fresh liveness, when presence is read, then one row per Session (Chat ID, client type, connected-since, last-seen, fingerprint) within TTL 180 s; any authenticated request refreshes liveness; viewer/daemon activity never keeps an Actor online.
- Given actors last seen within 24 h, when include_offline is set, then a separately-labeled offline-recently group returns, surviving restart via the claims index.
- Given an unreachable server, when reported, then it is reported unreachable — never as "everyone offline."

## Spec Change Log

### 2026-09-25 — review amendments (documentation-only)
- Read-model purity restored: the original Code Map called presenceSnapshot "a pure function" while the first implementation mutated the registry on read (180 s eviction freeing names). Ratified semantics after review: reads FILTER (hide) rows idle > presence TTL; the 12 h claim-time lease sweep is the only name-freeing path; an idle session reappears on its own next authenticated request (touch) without re-binding. Known-bad state avoided: third-party reads evicting other Actors' names.
- The Always clause's "actor/pre-auth request" wording narrowed to actor-class only: pre-auth requests carry no session, so liveness refresh is uninstantiable there (pre-auth/viewer/health never touch — tested).
- Spec Verification's "222 pre-existing untouched" corrected: registering GET /api/status + client_type necessarily invalidated four pins in pre-existing test files (each preserved its original intent, per the shared-pinning precedent).

## Review Triage Log

### 2026-09-25 — Review pass 1 (4 internal layers + codex-advisor[luna] gpt-6-luna)
- intent_gap: 0
- bad_spec: 0
- patch: 21: (high 2, medium 3, low 16)
- defer: 3: (low 3)
- reject: 4
- addressed_findings:
  - `high` `patch` presence response emitted fields outside AD-8's frozen vocabulary (online/offline_recently/chat_id/client_type) — dated spine amendment + vocabulary mirror + recursive payload⊆vocabulary contract test
  - `high` `patch` any read evicted sessions idle >180 s and freed their names (1.5's 12 h lease broken by third-party reads; idle sessions unrecoverable without re-bind) — reads now pure filters; lease sweep is the only freeing path; reappearance-without-rebind tested
  - `medium` `patch` rename to a different name reset client_type to null — carried over, tested
  - `medium` `patch` touch-failure path untested (fail-closed liveness could silently regress) — 500 request_failed pinned, no try/catch, recovery tested
  - `medium` `patch` FR-5 operator tuning absent — presenceTtlMs option + AGENT_ROOM_PRESENCE_TTL_MS env (strict validation); heartbeat-cadence tuning deferred to 1.7's adapter
  - `low` `patch` (remaining) clock-rollback upper bound on recentClaims, last_seen_at index, online/offline ordering pins, daemon/health/pre-auth non-touch probes, viewer credential on /api/presence 401, multi-session-same-Actor shape, client_type explicit-null alignment, status missing-Broadcast-Room → coded 500 (realm_bootstrap_incomplete), now-override exercised, comment fixes, DELETE-before-restart in restart test, includeOfflineFlag throw refactor, offline client_type absence documented
- notes: gpt-6-luna[max] matched (evidence hashes recorded in the archived audit); rejects = unreachable-server AC surface (client-side, 1.7 — harness row kept as documented evidence, title clarified), inclusive-window format invariant (runtime guard covers store-op callers), presence unbounded cardinality (bounded by session count / 24 h window; noted), sessionKey-convention startup check (documented on the wrapper); defers = per-request durable write measurement under load (Story 1.8/4.4), heartbeat cadence tuning (1.7), AGENTS.md map (template-managed)


## Design Notes

One liveness mechanism: the auth stage's sliding refresh and presence touch are the same event (touch(persist) from 1.5) — no separate heartbeat surface server-side; the 60 s client heartbeat (1.7) simply produces authenticated requests. Offline-recently excludes online Actors and the reader's own Actor (reading your own stale claim while online is noise). GET /api/status lands here (not 1.7) because 1.8's checkpoint needs realm_id + broadcast_room_id before the MCP tools exist, and the route is frozen in AD-8.

## Verification

**Commands:**
- `node --test` -- expected: all pass; 222 pre-existing untouched.
- `grep -rn "include_offline" server/api/routes.mjs server/core/session-registry.mjs` -- expected: allowlist + snapshot consumption.

## Auto Run Result

Status: done

**Summary:** Presence is live: GET /api/presence returns online (one row per live Session: chat_id, client_type, connected_since, last_seen, fingerprint — TTL 180 s filter, pure reads) and offline_recently (claims within 24 h excluding online and the reader's own Actor, deduped most-recent per Actor, restart-surviving); GET /api/status returns {realm_id, version, broadcast_room_id}; one liveness mechanism — every authenticated actor request touches (sliding auth TTL + presence + durable claim recency together); client_type declared at bind from a closed set; operator-tunable TTL via option/env; response payloads contractually pinned to the frozen vocabulary.

**Files changed:** `server/core/session-registry.mjs` (clientType, pure presenceSnapshot), `server/api/server.mjs` (presence/status handlers, touch wiring, tuning options/env), `server/api/routes.mjs`, `server/store/room-log.mjs` (recentClaims + last_seen_at index), `server/constants.mjs`, spine AD-8 amendments (client_type, broadcast_room_id, response group labels), `tests/presence.test.mjs` (26 tests) + additive updates to five pinning suites.

**Review findings breakdown:** 21 patched (high 2, medium 3, low 16), 3 deferred, 4 rejected; 0 intent gaps; 0 bad_spec (3 documentation-only amendments recorded).

**Follow-up review recommendation:** true — patched high 2 / medium 3 / low 16, score 3×3 + 16 = 25 ≥ 5 (high present regardless).

**Verification performed:** `node --test` 250/250 (3 consecutive runs; pre-1.6 suites green); payload⊆vocabulary contract test; pure-read/lease/reappearance behavioral rows with injectable clocks; env/startup validation matrices; touch-failure 500 path; v0.1 diffs empty.

**Residual risks:** every authenticated bound request performs a synchronous durable write (accepted 1.6 trade; measure under 1.8 load / Story 4.4); offline rows never carry client_type (claims index holds none); unreachable-server AC is client-side evidence until 1.7's adapter; heartbeat cadence (60 s ±10%) is constants-only until 1.7.
