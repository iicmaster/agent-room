---
title: 'HTTP API host, middleware classes, health & realm bootstrap'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: '4f94f73c1d05b2360fe2fdc384bbb135897b85d4'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/docs/implementation/epic-1-context.md'
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/implementation/spec-1-2-store-schema-v2-rooms-the-durable-log.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** no HTTP door exists. Stories 1.4–1.8 (local auth, chat ids, presence, MCP adapter, the first-conversation checkpoint) all need a versioned API host where every request passes the same gated pipeline; without it each new route would grow its own ad-hoc checks.

**Approach:** build the host and the four route classes as middleware classes behind one fixed pipeline (protocol → transport → auth → budgets → authz → handler), first-boot realm bootstrap (realm_id + implicit Broadcast Room), unauthenticated `GET /health`, and executable contract tests pinning the frozen AD-8 wire surface. Only the health route and the bootstrap are live this story; sessioned routes join when their stories land (additive policy).

## Boundaries & Constraints

**Always:** the pipeline order protocol → transport → auth → budgets → authz → handler is one fixed construction asserted by test — a reordered gate fails; the protocol stage (`Agent-Room-Protocol: 1`, value must match a supported version, response echoes it) applies to actor and pre-auth classes only — viewer and health are exempt; a missing header is 400 `protocol_required`, a mangled/unsupported version is 400 `invalid_protocol` naming the supported versions, both with zero state change; a rejection at any stage in any class never reaches a handler (proven with handler spies), never mutates the store, consumes nothing, advances nothing; unknown request fields are rejected, not ignored; handlers contain no gate logic; every error's HTTP status comes from constants.mjs's table, never per-route; JSON envelope `{ok, result|error:{code,message}}` with snake_case codes; the route table and field vocabulary are frozen data cited verbatim from spine AD-8 (a contract test fails on drift); `server/core/` imports no `node:http`, no MCP SDK, no CLI lib (boundary walk fails otherwise); first boot mints a realm_id (UUID) and creates the Broadcast Room implicitly — idempotent across restarts (no join verbs exist for it); `GET /health` answers unauthenticated, side-effect-free; the server binds loopback only (Local Mode = configuration, AD-10) and records `{pid, port, version}` in runtime.json (0600, atomic); direct launches gate the runtime (Node ≥ 24.15 / SQLite ≥ 3.51.3) and exit 1 with a one-line error.

**Block If:** the pipeline cannot express the four route classes without duplicating gate logic between them (halt with the design conflict); the store cannot gain the realms/broadcast-bootstrap primitives additively without touching v0.1 modules.

**Never:** no session token issuance or auth answers (Story 1.4 — the auth stage runs an injectable verifier that rejects until 1.4 provides the real one); no actor/pre-auth route handlers beyond health this story — unimplemented frozen routes stay unregistered (unknown paths → 404 `request_failed`); no unix-socket work and no changes to `server/roomd.mjs`, `server/database.mjs`, or v0.1 tests; no TLS termination, invite enrollment, rate-limit policies (budgets stage is a structural pass-through until Epic 4), ban/ACL enforcement (authz pass-through until Epics 3–4); no MCP work; no `wait_ms` long-poll (Story 1.6/1.7 wiring — the messages routes do not exist yet).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| health | GET /health, no headers | 200 `{ok:true,...}`, no protocol header required, no state change | No error expected |
| missing header | any /api/* request without `Agent-Room-Protocol` | 400 `protocol_required`; handler never invoked; store unchanged | diagnosable |
| bad version | header value "2" or mangled | 400 `invalid_protocol` naming supported versions; response echoes nothing | diagnosable |
| version echo | valid header on /api/* | response carries `Agent-Room-Protocol: 1`; viewer/health responses do not | No error expected |
| unknown field | POST body with a non-vocabulary field on a wired route | 400, field rejected not ignored | coded error |
| fixed order | pipeline construction | stages invoke in protocol→transport→auth→budgets→authz→handler order; viewer/health skip protocol; reordered construction fails the assertion | test fails otherwise |
| rejection invariant | any stage rejection | handler spy not called; store byte-identical (db file hash unchanged) | test fails otherwise |
| first boot | fresh data dir, server start | realm row minted, Broadcast Room exists (kind broadcast) | No error expected |
| restart idempotence | stop, start again on same data dir | same realm_id, still exactly one Broadcast Room | No error expected |
| boundary | static walk of server/core/ | zero `node:http`/MCP/CLI imports | test fails otherwise |

</intent-contract>

## Code Map

- `server/api/server.mjs` -- NEW entrypoint: `startServer({ dataDir, host = '127.0.0.1', port = 0 })` → { port, close(), runtimeRecord }; node:http, loopback bind, runtime.json via `atomicWriteJson`/`runtimeRecordPath` (runtime.mjs), realm bootstrap on open, health route, per-request pipeline dispatch by route class.
- `server/api/pipeline.mjs` -- NEW: stage classes ProtocolStage, TransportStage, AuthStage, BudgetStage, AuthzStage + per-class assembly (actor/pre-auth = all six; viewer/health skip protocol); shared reject(code) helper mapping via PUBLIC_ERROR_STATUS; request context object; body reader with unknown-field rejection against per-route allowed-field sets derived from the frozen vocabulary.
- `server/api/routes.mjs` -- NEW frozen data: route table (class, method, path pattern) and field vocabulary exactly as spine AD-8 records them; contract test source of truth.
- `server/core/realm.mjs` -- NEW: `bootstrapRealm(store)` → mint/get realm_id, ensure exactly one Broadcast Room; pure orchestration, no transport imports.
- `server/store/room-log.mjs` -- additive only: `realms` table via `CREATE TABLE IF NOT EXISTS` in the existing schema sequence (v2 stays the in-progress v0.2 schema within Epic 1 — no version bump, no v0.1 impact), plus `getRealmId()`, `insertRealm(id)`, `findBroadcastRoom()`.
- `server/constants.mjs` -- import statuses; additive PUBLIC_ERROR additions only if a new code is unavoidable (prefer existing: `protocol_required`/`invalid_protocol` need registration — add with 400).
- `tests/api-host.test.mjs`, `tests/api-contract.test.mjs`, `tests/core-boundary.test.mjs` -- NEW: spawn real server children for health/protocol/echo/rejection-invariant/bootstrap/restart rows; sentinel-order pipeline test with handler spies; contract pins vs embedded AD-8 text; boundary walk (existing walker style).

## Tasks & Acceptance

**Execution:**
- `server/api/pipeline.mjs` + `server/api/routes.mjs` -- stage classes, fixed-order assembly, frozen table data -- the identical-gate door for 1.4–1.8.
- `server/api/server.mjs` -- host, loopback bind, runtime.json, health, dispatch -- the process Stories 1.4+ spawn.
- `server/core/realm.mjs` + store additions -- realm mint + implicit Broadcast Room, restart-idempotent -- AD-14 foundations.
- `server/constants.mjs` -- register `protocol_required` + `invalid_protocol` (400) additively -- header AC needs canonical codes.
- tests -- every matrix row; order test must fail if gates are reordered; rejection-invariant test hashes the db file before/after -- AC-level proof.

**Acceptance Criteria:**
- Given an /api/* request missing or mangling the protocol header, when received, then 400 `protocol_required`/`invalid_protocol` naming supported versions, zero state change.
- Given first boot, when the server starts, then realm_id minted, Broadcast Room implicit, `GET /health` unauthenticated.
- Given the four route classes, when a request arrives, then viewer and health skip the protocol stage and handlers contain no gate logic; the fixed order is asserted and reordering fails.
- Given the module tree, when the boundary test runs, then core imports no transport/CLI; the contract test pins route table, vocabulary, envelope, and status mapping against spine AD-8/AD-9 verbatim.

## Spec Change Log

### 2026-09-25 — review clarification (documentation-only, no code re-derivation)
- Finding: the Never clause "no changes to ... v0.1 tests" read literally forbids extending `tests/constants.test.mjs` (a v0.1-era shared pinning file), which additive error-code registration requires — an internal conflict, since Story 1.2 set the additive-extension precedent for that file.
- Amendment: "v0.1 tests" means v0.1 BEHAVIOR tests (daemon/database/daemon-client/mcp suites). Shared pinning files (constants.test.mjs) extend additively, per the 1.2 precedent. Known-bad state avoided: freezing the wire-contract pin against additive codes. KEEP: the additive-only extension pattern for shared pinning files.
- Related spine amendment made this story (by implementation, per review): AD-8 response vocabulary gains `version` and `realm_id` (dated amendment in-document); the contract test now reads the live spine file.

## Review Triage Log

### 2026-09-25 — Review pass 1 (4 internal layers + codex-advisor[luna] gpt-6-luna)
- intent_gap: 0
- bad_spec: 0
- patch: 26: (high 3, medium 13, low 10)
- defer: 3: (low 3)
- reject: 6
- addressed_findings:
  - `high` `patch` Broadcast Room creator was a fabricated all-zero fingerprint (violates no-placeholder-identities) — created_by_fingerprint made nullable via converging rebuild, system room has NULL creator, sentinel deleted, boundary test asserts no fingerprint literal in core
  - `high` `patch` post-listen startup failure leaked the live listener — httpServer+store closed on every failure path; port-release test with obstructed runtime.json
  - `high` `patch` protocol gate skipped unmatched /api paths (spec matrix: ANY /api/* request without header → 400) — gate now pre-match over the /api/ prefix; echo on every /api response incl. outer catch; statuses never hard-coded
  - `medium` `patch` request_failed 404 masked internal faults and 5xx was unreachable — route_not_found 404 registered for unknown paths; request_failed = AD-8 unknown-error fallback at 500
  - `medium` `patch` contract test pinned an embedded AD-8 copy, not the live spine — now parses ARCHITECTURE-SPINE.md at test time; spine amended (version, realm_id into response vocabulary)
  - `medium` `patch` single verifier slot let actor/viewer credentials cross — per-class sessionVerifier/viewerVerifier slots with isolation tests
  - `medium` `patch` concurrent/partial bootstrap could crash or double-mint — insertRealm convergence, in-transaction ensureBroadcastRoom, partial recovery on boot, unit tests
  - `medium` `patch` GET/DELETE bodies silently ignored; requestFields mutable — bodies rejected on non-body methods, deep-freeze + immutability test, duplicate query keys rejected
  - `medium` `patch` internal errors were silent 404s — one bounded redacted stderr line on fallback paths; undeclared-code fallback derived from PUBLIC_ERROR_STATUS
  - `medium` `patch` startup/verifier hardening — verifier args validated at startup; malformed verifier outcomes coded; aborted bodies → request_cancelled; runtime.json unlink re-checks pid
  - `medium` `patch` pre-1.3 v2 databases (no realms table) upgrade path untested — convergence fixture added; registerHandler exported with frozen-table validation; canonical unauthorized message; api entrypoint added to gate tests
- notes: gpt-6-luna[max] matched (user seat directive); rejects = v1-file mutation claim (false positive — probe/refusal verified to precede ensureRealmTable), handler-policy static guard (vacuous by construction, R3-A), invariant enumeration subsumed by db-hash proof, transport sentinel-only, function-level additive grain; defers (3, all Epic 5 viewer): /viewer no-trailing-slash alias, static-asset query-string policy, /viewer/auth session exemption


## Design Notes

Route-class dispatch: exact class per method+path from the frozen table; classes are data-driven so later stories register handlers without touching pipeline order. The auth/budget/authz stages are structural now (auth rejects all actor requests with 401 `unauthorized`-family via the injectable verifier; budgets/authz pass through) — their policy arrives in Epics 3–4, but the ORDER invariant is exercised this story. runtime.json is written after the listener is live (loser-attach contract for 1.4's ensureServer). `protocol_required` = header absent; `invalid_protocol` = present but unsupported/mangled, error message lists supported versions from the constants module.

## Verification

**Commands:**
- `node --test` -- expected: all pass; new api/core suites green; pre-existing 88 untouched.
- `grep -rn "node:http" server/core/` -- expected: no matches.
- `grep -rnE "protocol_required|invalid_protocol" server/constants.mjs` -- expected: both registered with statuses.

## Auto Run Result

Status: done

**Summary:** The versioned API door exists: one fixed six-stage middleware pipeline (protocol → transport → auth → budgets → authz → handler) over four route classes with the frozen AD-8 route table/vocabulary as data pinned against the live spine; unauthenticated `GET /health`; first-boot realm bootstrap (realm_id UUID + implicit creator-less Broadcast Room, idempotent and concurrency-safe across restarts); loopback-only `startServer` writing runtime.json `{pid, port, version}` after listen; contract tests now parse the spine itself. Only health is live; sessioned routes join additively in 1.4–1.8.

**Files changed:** `server/api/routes.mjs`, `server/api/pipeline.mjs`, `server/api/server.mjs`, `server/core/realm.mjs` (new); `server/store/room-log.mjs` (additive: realms table + primitives, nullable creator convergence), `server/constants.mjs` (protocol_required/invalid_protocol/route_not_found registered, request_failed→500, SUPPORTED_PROTOCOL_VERSIONS); spine AD-8 dated amendment; tests: `api-host` (26+), `api-contract`, `core-boundary`, `runtime`/`constants` extended.

**Review findings breakdown:** pass 1 (4 internal layers + gpt-6-luna): 26 patched (high 3, medium 13, low 10), 3 deferred (Epic 5 viewer), 6 rejected (incl. 1 verified false positive); 0 intent gaps; 0 bad_spec (1 documentation-only spec clarification recorded).

**Follow-up review recommendation:** true — patched high 3 / medium 13 / low 10, score 3×13 + 10 = 49 ≥ 5.

**Verification performed:** `node --test` 127/127 (3 consecutive runs incl. SIGKILL/concurrency suites); core boundary grep clean; no zero-fingerprint anywhere; append-only store scan clean; `git diff` on roomd.mjs/database.mjs empty.

**Residual risks:** field-gate's fixed position inside runPipeline is invariant-tested via stage sentinels but not separately order-pinned; viewer routes are structurally gated but dead until Epic 5 (3 deferred notes recorded); budgets/authz remain pass-throughs until Epics 3–4; unregistered frozen routes answer 401 (actor) / 404 (pre-auth) by design until their stories land.
