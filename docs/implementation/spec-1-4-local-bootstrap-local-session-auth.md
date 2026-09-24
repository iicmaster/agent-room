---
title: 'Local bootstrap & local session auth'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: '2c493475c1bad2acd7dd91b7cab94065e5106d64'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/docs/implementation/epic-1-context.md'
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/implementation/spec-1-3-http-api-host-middleware-classes-health-realm-bootstrap.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** the API host exists but nothing starts it automatically and nothing issues session tokens — Local Mode still has no zero-config path (FR-1), and Story 1.5–1.8's sessioned routes have no credential mechanism.

**Approach:** build the client-side `ensureServer` (evolved from v0.1's `ensureDaemon`: hardlink startup lock stale after 15 s, detached spawn, readiness poll, loser attaches via runtime.json with dead-pid + unauthenticated-health staleness proof) and the local credential path: a 0600 shared-data-dir local token file that `POST /api/auth/local` exchanges (Bearer) for a 12 h sliding session token; the session verifier from Story 1.3 becomes the real bearer-token check. Register the /api/auth/local handler only — other routes stay unregistered.

## Boundaries & Constraints

**Always:** ensureServer uses the shared data dir (`AGENT_ROOM_DATA_DIR`/`~/.agent-room`), never PLUGIN_DATA; the startup lock is a hardlink, stale after 15 s, and a stale lock is reclaimed only when the pid is dead; a stale runtime.json entry is reclaimed only when pid is dead AND `GET /health` against its port is unreachable — otherwise it is reused; the spawned server is the same `server/api/server.mjs` binary (no local-mode fork); the local token file is 0600 regular non-symlink size-bounded in the shared data dir, created on first need; `POST /api/auth/local` is pre-auth class (no session required), presents the local token as Bearer, and returns a session token whose TTL is 12 h sliding (activity refreshes); session tokens are verified by the actor-class auth stage (issuer-verifier pair, in-memory registry, no server restart persistence required this story); the token file itself is never accepted as a per-request credential on any other route; the session token never appears in logs or stderr; registerHandler-only route addition; no state change on any rejection.

**Block If:** the hardlink lock cannot be made race-safe on this platform (halt with evidence); issuing session tokens requires persisting them to disk (in-memory registry is the 1.4 scope — restart invalidation is Epic 2 continuity).

**Never:** no unix socket anywhere (AR-1 — no `roomd.sock` creation, no v0.1 daemon spawn); no remote-mode auth (challenge/enroll/answer routes stay unregistered — Epic 4); no Chat ID selection or chat_id_claims (Story 1.5); no presence writes; no changes to roomd.mjs/database.mjs/v0.1 behavior tests; no TLS work; no MCP work; no viewer routes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| first ensureServer | no runtime.json, no lock | spawns server, waits ready, returns {port, runtimeRecord}; shared data dir used | spawn failure → coded error |
| race first boot | two concurrent ensureServer calls, fresh dir | exactly one spawns (hardlink lock); loser waits then attaches via runtime.json; one server process total | No error expected |
| stale lock | lock present, owning pid dead, age > 15 s | reclaimed, boot proceeds | No error expected |
| lock held live | lock present, owning pid alive | waiter proceeds to runtime.json attach path | No error expected |
| stale runtime.json | recorded pid dead AND /health unreachable | entry reclaimed, new server spawned | No error expected |
| half-stale runtime.json | pid dead but health answers (foreign process) | NOT reclaimed — attach refused or reused per health probe result; no kill of the foreign process | coded error, never auto-kill |
| live attach | runtime.json pid alive + health OK | attach: return existing port; no second server | No error expected |
| local auth happy path | POST /api/auth/local, Bearer <local token> | 200 {session token}; token file never stored as session | No error expected |
| wrong local token | Bearer mismatch | 401 unauthorized-family; zero state change | coded |
| missing Bearer | no Authorization header | 401 | coded |
| token file missing | first auth attempt, no file | created 0600 on first need, then flow proceeds (or coded error this request — pick one, document in code) | no crash |
| session use | GET /api/status-family actor route with session token | verifier accepts (real check replaces 1.3's reject-all) | No error expected |
| session on viewer route | session token against /viewer/* | rejected — credentials never cross classes | 401 |
| local token as session | Bearer <local token> on actor route | rejected — token file is not a per-request credential | 401 |
| bindings | inspect listening server | 127.0.0.1 only; no unix socket file created anywhere | test fails otherwise |

</intent-contract>

## Code Map

- `server/daemon-client.mjs` -- v0.1 ensureDaemon (hardlink lock pattern, spawn, readiness poll) — the ratified pattern to evolve; do NOT modify; new `server/client/ensure-server.mjs` mirrors it for HTTP: read runtime.json → pid-liveness + GET /health probe → spawn `node server/api/server.mjs` detached with env → poll /health → return record.
- `server/api/server.mjs` -- 1.3 host: gains nothing structural; `registerHandler('POST /api/auth/local', ...)` + real session verifier injection (issuer/verifier module from `server/api/session.mjs`).
- `server/api/session.mjs` -- NEW: `createSessionRegistry({ ttlMs = SESSION_TTL_MS })` → issue(actorFingerprint) → token; verify(token) → {actorFingerprint} | reject; sliding 12 h TTL from constants; in-memory Map; constant-time compare; tokens are 256-bit random base64url; never logged.
- `server/api/local-token.mjs` (or core) -- NEW: loadOrCreateLocalToken(sharedDataDir) using runtime.mjs's file machinery (0600, non-symlink, size-bounded).
- `server/constants.mjs` -- SESSION_TTL_MS exists (12 h); additive codes only if unavoidable (prefer `unauthorized` 401, `invalid_request` 400).
- `tests/ensure-server.test.mjs`, `tests/local-auth.test.mjs` -- NEW: spawn real children; race test launches two concurrent ensureServer on a fresh dir asserting one pid; stale-lock/stale-record probes with killed children; the full matrix.

## Tasks & Acceptance

**Execution:**
- `server/client/ensure-server.mjs` -- race-safe auto-start + attach -- FR-1's zero-config engine.
- `server/api/session.mjs` + local-token loader + `POST /api/auth/local` handler + real verifier wiring -- the local credential path.
- `server/api/routes.mjs` -- register the pre-auth route in the frozen table (it is already in AD-8's list; mark implemented).
- tests -- every matrix row with real processes; negative FR-1 test (no URL/token/room-id input anywhere in the local path).

**Acceptance Criteria:**
- Given two sessions racing first boot, when both run ensureServer, then exactly one server wins and the loser attaches via runtime.json on the shared data dir.
- Given a stale runtime.json, when its pid is dead AND health is unreachable, then it is reclaimed; otherwise reused.
- Given the 0600 local token file, when POST /api/auth/local presents it as Bearer, then a session token returns; the file is never a per-request credential.
- Given a running local server, when sockets are inspected, then 127.0.0.1 only, no unix socket exists, and first use requests nothing but the Chat ID.

## Spec Change Log

## Review Triage Log

## Design Notes

Staleness = dead-pid AND unreachable-health for BOTH lock and runtime.json — a live-but-unhealthy server is never killed (the foreign-process row). ensureServer returns {port, record, spawned:boolean} so 1.7's MCP adapter can log which path happened. The session registry keys by actor fingerprint; Story 1.5 attaches Chat IDs at connect time without touching this module. PLUGIN_DATA is never consulted by ensureServer — the shared dir is the realm's home (AD-10).

Implementation decisions recorded (2026-09-25, per the matrix's "pick one, document in code" latitude):

- Half-stale runtime.json (dead pid, answering port): the health probe result decides — a responder proving to be an agent-room server (200 `{ok:true, result:{version}}`) is reused (`spawned:false`); anything else on the port refuses with `server_port_conflict`. Nothing is ever signalled; the record is left untouched on reuse, reclaimed only on the full staleness proof.
- Token file missing at first auth attempt: the HTTP path is read-only (`readLocalToken` — missing/invalid → 401 `local_token_invalid`, zero creation); creation belongs to the client bootstrap (`loadOrCreateLocalToken`, which ensureServer guarantees after every successful boot/attach). Rejections change no state on any surface (db + WAL + token file + runtime.json all hash-stable across rejection rows).
- Local session's registry key: sessions bind to the caller's installation public key — auth/local requires the frozen-vocabulary `public_key` field (43-char base64url → 32 raw bytes), fingerprint = sha256 over the raw bytes (reusing keys.mjs's helper); the local token remains the OS-user bootstrap credential and is NEVER an identity; presentation is not possession proof (challenge-response is Epic 4's remote path). Two installations → distinct Actor fingerprints holding sessions simultaneously; one installation's re-exchange adds a distinct session (multi-Session-per-Actor is legal; Chat IDs differentiate in 1.5).
- Lock/record paths: the HTTP bootstrap uses its own `server.start.lock` (additive `serverStartupLockPath` in runtime.mjs) so the frozen v0.1 daemon files are untouched; the lock mirrors daemon-client's hardlink pattern with the pid-liveness reclaim gate (age > 15 s AND dead pid).
- `session_token` joined the AD-8 response vocabulary by dated spine amendment (additive, per the 1.3 `version`/`realm_id` precedent); the contract test reads the live spine.
- New codes registered additively in constants: `server_start_busy` 503, `server_start_failed` 500, `server_start_lock_invalid` 500, `server_port_conflict` 409, `local_token_invalid` 500.

## Verification

**Commands:**
- `node --test` -- expected: all pass; new suites green; 127 pre-existing untouched.
- `ls` the shared data dir after a boot -- expected: no `roomd.sock`, `runtime.json` + token file present at 0600.
- `grep -rn "roomd.sock\|unix" server/client/ server/api/` -- expected: no matches (AR-1).

## Spec Change Log

### 2026-09-25 — review amendments (documentation-only; code re-derived in the same pass)
- Lock-staleness contradiction fixed: the Design Notes' "dead-pid AND unreachable-health for BOTH lock and runtime.json" was impossible for a lock (no port). Ratified decomposition: lock = age > 15 s AND dead owner pid; runtime.json = dead pid AND unreachable health. Known-bad state avoided: silent drift from the recorded rule. KEEP: per-surface staleness predicates.
- Identity-binding amendment: the original contract's "auth/local carries no identity fields" premise was wrong against D13/FR-3/AD-10 — with claims landing in 1.5, a shared token-digest fingerprint would have become enforced trust semantics. auth/local now requires `public_key` (frozen vocabulary, additive per NFR-8; dated spine amendment). KEEP: local token = bootstrap credential only; fingerprint = sha256 over raw 32-byte public key; no possession-proof claim locally.

## Review Triage Log

### 2026-09-25 — Review pass 1 (4 internal layers + codex-advisor[luna] gpt-6-luna round-table)
- intent_gap: 0
- bad_spec: 0
- patch: 24: (high 1, medium 10, low 13)
- defer: 2: (low 2)
- reject: 5
- addressed_findings:
  - `high` `patch` local sessions bound to the shared token's digest (every installation one Actor, would have poisoned 1.5's durable claims) — auth/local now requires `public_key`, sessions bind to sha256(raw 32 bytes), token-digest principal deleted, distinctness + multi-session tests, spine amended
  - `medium` `patch` no-state-on-rejection contradicted first-need token creation — read-only HTTP path, creation client-side, 0600 re-tightened on read, zero-state proof extended to token file + runtime.json, equal-length wrong-token row
  - `medium` `patch` readiness failure left the detached child alive — SIGTERM-then-SIGKILL reap before lock release on every post-spawn failure, never-ready-child test
  - `medium` `patch` half-stale reuse had no end-to-end proof (could attach to another realm's server) — reuse performs a real auth/local exchange; cross-dir record now fails
  - `medium` `patch` no version gate on attach — major-version compatibility enforced naming both versions
  - `medium` `patch` lock races: transient ENOENT fatal, reclaim TOCTOU — retry on ENOENT, rename-fence reclaim
  - `medium` `patch` foreign-responder classification inconsistent across pid states — port_conflict immediately in both phases; probeHealth overall timeout; mid-response errors = unreachable (retry), never foreign-proof; runtime.json-as-directory coded
  - `medium` `patch` session registry unbounded (expired entries never swept) — lazy sweep on issue, SESSIONS_MAX with eviction, restart-invalidation test, multi-session semantics documented
  - `medium` `patch` waitMs (5 s) could never reach the 15 s staleness window — raised to 20 s with a real mid-wait reclaim test; spawn-failure row exercised
  - `medium` `patch` injected verifier + default registry incoherence — sessionRegistry threaded as one pair with startup validation
  - `low` `patch` (remaining) Bearer length cap, redundant timingSafeEqual self-compare removed, all bootstrap constants pinned, state_file_invalid registered, implemented-flag enforced both directions, unregistered pre-auth routes re-pinned, race test order-tolerant, DR-2 provisional wording, concurrent token-creator test, AD-9 mirror amendment
- notes: gpt-6-luna[max] matched; round-table unanimous on identity binding ("not possession proof"); rejects = ensureServer has no production caller (1.7 wires the MCP adapter per plan), server_start_* codes in HTTP tables (shared constants), corrupt-record sibling-spawn residual (documented), FR-1 negative surface provisional (adapter completes in 1.7); defers = AGENTS.md module map + spine layout location of client/ (both template-managed documentation)

## Auto Run Result

Status: done

**Summary:** Local Mode's engine and credential path exist: `ensureServer` (race-safe hardlink-lock spawn, dead-pid+unreachable-health staleness, fenced runtime.json reclaim, version-gated attach, orphan reaping, end-to-end credential proof on reuse) and `POST /api/auth/local` exchanging the 0600 local token (Bearer-only) for a 12 h sliding session token bound to the caller's installation public key (auto-enrollment under the OS-user boundary; two installations are distinct Actors). The 1.3 reject-all verifier is replaced by the real actor-class check; viewer slot stays sealed. Loopback-only, no unix socket anywhere, no URL/token/room-ID input in the local path.

**Files changed:** `server/client/ensure-server.mjs`, `server/api/session.mjs`, `server/api/local-token.mjs` (new); `server/api/server.mjs`, `server/api/routes.mjs`, `server/constants.mjs`, `server/runtime.mjs` (modified); spine AD-8 + AD-9 dated amendments; tests: `ensure-server` (19), `local-auth` (22), `constants`/`api-contract`/`api-host` extended; reviews archived in `docs/implementation/reviews/story-1.4-luna-*`.

**Review findings breakdown:** 24 patched (high 1, medium 10, low 13), 2 deferred, 5 rejected; 0 intent gaps; 0 bad_spec (2 documentation-only spec amendments recorded).

**Follow-up review recommendation:** true — patched high 1 / medium 10 / low 13, score 3×10 + 13 = 43 ≥ 5.

**Verification performed:** `node --test` 172/172 (3 consecutive runs; 127 pre-1.4 suites untouched); AR-1 grep clean; zero-state hashing across db+WAL+token+runtime.json on rejection rows; real-process race/staleness/reclaim/orphan/cross-dir rows; manual boot: 0700 dir, 0600 files, no socket residue.

**Residual risks:** ENOENT-retry lock path implemented but not deterministically testable; malformed runtime.json self-heals by overwrite (documented); sessions in-memory (Epic 2 continuity); budgets remain pass-through until Epic 4 — repeated rejected auth attempts are unthrottled at the wire until then (recorded exposure); local public-key presentation is declaration, not possession (within Local Mode's OS-user threat model, by design).
