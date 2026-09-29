# Story 4-1 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
FIX-FIRST

# Findings

- [high] The declared-remote client still reaches local-token bootstrap and can present that token on a recovery path.
  Evidence: server/client/api-client.mjs:652-657 calls ensureServer before authenticateOnce. server/client/ensure-server.mjs:407-413 unconditionally calls loadOrCreateLocalToken from returnRecord. Its half-stale reuse path reads the token and sends POST /api/auth/local at server/client/ensure-server.mjs:220-228, reached when a dead recorded pid still has a healthy server at :254-259. The declared-remote test exercises a healthy child and checks only its captured auth calls at tests/challenge-auth.test.mjs:831-845 and :888-913.
  Why: the client’s remote authentication branch has no local fallback, but the path it always calls touches the local token file, and a recovery case presents it. This hits the brief’s declared-remote Block If. The test does not exercise that recovery path.

- [medium] The transport getter reports remote before challenge authentication succeeds.
  Evidence: server/client/api-client.mjs:351-359 initializes transportMode from the declaration; the getter exposes it at :682. The spec requires the earned marker only after a successful exchange at docs/implementation/spec-4-1-remote-challenge-authentication.md:26 and :45. The test explicitly expects remote after a not_enrolled failure at tests/challenge-auth.test.mjs:930-941.
  Why: a declared value is observable as the trust-matrix transport fact before the client proves possession, contrary to the contract. The test pins the contradictory behavior.

- [medium] The rejected-local-exchange test cannot detect enrollment of a new key before credential validation.
  Evidence: tests/challenge-auth.test.mjs:684-695 enrolls identity first; :699-708 rejects a wrong token using that same already-enrolled public key and only checks that the row count remains one. server/store/room-log.mjs:1409-1414 makes duplicate enrollment a no-op. The current handler does validate the token before enrolling at server/api/server.mjs:239-245.
  Why: if enrollment moved before the token check, this test would still pass for the existing fingerprint. The code is ordered correctly today, but the asserted rejected-exchange invariant is not proven for an unenrolled key.

- [medium] The four challenge bounds have no independent literal oracle or regression guard.
  Evidence: server/constants.mjs:47-50 declares 32, 60_000, 1000, and 256. tests/constants.test.mjs:80-93 says this is the sole literal-pinning location, but :122-155 has no challenge bounds; rg -n 'CHALLENGE_' tests/constants.test.mjs returned no matches. tests/challenge-auth.test.mjs:39-47 imports production constants and :67-70, :332-349, :360-372, and :658-665 derives expectations from them.
  Why: current enforcement imports the named constants, but the suite adapts if any bound drifts and does not fail if the same numeric bound is restated in production code. The contract asks for literal test oracles and the AD-9 single-home rule.

- [low] The spec’s row-to-harness map overstates which rows use spawned children.
  Evidence: docs/implementation/spec-4-1-remote-challenge-authentication.md:67 labels rows 1–4, 7–8, and 10–13 as spawned-server rows. In the test file, rows 2, 3, 4, 7, and 13 call startServer directly at :482, :525, :576, :611, and :1033; spawned children are used at :442, :679, :831, and :955.
  Why: those in-process cases still use the real HTTP server and SQLite store, so their route assertions are not vacuous. They do not provide the process-boundary evidence the Code Map claims for those rows.

# Checks

## 1. Intent-contract — FINDINGS F-1 through F-5

**Intent, Problem and Approach**

- PASS — The frozen route rows remain pre-auth with challenge fields exactly public_key and answer fields exactly nonce plus signature; enroll remains unimplemented: server/api/routes.mjs:70-79. The route-contract test pins both field sets: tests/api-contract.test.mjs:247-253.
- PASS — The shared session registry is the single issuer with 12-hour sliding TTL and capacity behavior: server/api/server.mjs:131-140, :907-914, and :994-1001; server/api/session.mjs:11-16 and :44-48. loadOrCreateKeypair returns fingerprint, public key, and path, not private bytes: server/keys.mjs:158-172.
- PASS — The declared connection-mode seam is exact-match remote: server/client/api-client.mjs:81-97. The challenge route accepts any well-formed raw key; answer consumes first, verifies against the recorded key, gates on durable enrollment, then uses the effective session registry: server/api/server.mjs:258-265 and :275-306.
- PASS — Enrollment is added through IF NOT EXISTS plus exact column verification and STRICT-table verification without a schema-version change: server/store/room-log.mjs:435-449, :695-720, and :807-829. The table is created and checked on each open at :815-824.
- FINDING F-1 — The client bootstrap called before either authentication path touches the shared local-token file, and its half-stale reuse proof can send it, despite the declared-remote contract.

**Always**

| Clause | Result and evidence |
|---|---|
| One session mechanism; challenge tokens use the same registry as local | PASS — both handlers resolve context.sessionRegistry and both issue through it: server/api/server.mjs:243-245 and :303-306; startup installs one effective registry at :907-914. |
| Bind at challenge; consume before signature verification | PASS — nonce records the raw key, is deleted before expiry is checked, and returns it once: server/api/challenge.mjs:46-84; answer consumes before verify: server/api/server.mjs:295-301. |
| Open challenge, enrolled answer; additive durable table; local exchange is the enrollment writer | PASS in code — challenge is open at server/api/server.mjs:248-265; answer gate is at :303-306; local handler compares credentials before enrollment at :239-245; store insert keeps the first timestamp at server/store/room-log.mjs:1409-1426. Rejected-local proof is FINDING F-3. |
| In-memory nonce state; durable enrollment; bounds and error codes centralized | PASS in current code — registry is a Map at server/api/challenge.mjs:42-44; constants are imported at :22-31 and server/api/server.mjs:84, :292-293; error text/status live in server/constants.mjs:140-192 and :222-264. Independent bounds proof is FINDING F-4. |
| Private key stays in keys.mjs; remote branch does not use local credentials; transport is earned after exchange | PASS for key scope — server/keys.mjs:181-204 returns the signature only and :212-221 verifies raw public keys. FINDING F-1 for the bootstrap token path; FINDING F-2 for transport visibility. |
| AD-8 dated amendment has no backticks except nonce | PASS — responses prose at docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:113 contains only the nonce field token in backticks; response vocabulary includes nonce at server/api/routes.mjs:136-158. |
| Rejections leave no durable claims/session/enrollment; real-child tests and injectable clocks | PASS for challenge refusals — replay asserts session count and store hash unchanged at tests/challenge-auth.test.mjs:542-548; unenrolled refusal does so at :621-627. FINDING F-3 for the local exchange’s vacuous rejection assertion. Clock tests cover the nonce boundary at :332-349 and sliding session behavior at :743-775. Child coverage exists, but the row map is overstated in F-5. |

**Block If triggers**

| Trigger | Result |
|---|---|
| Replay yields a token | PASS — exact nonce/signature are resent; second token and state change are asserted absent: tests/challenge-auth.test.mjs:535-548. |
| Signature from a key other than the recorded key succeeds | PASS — a correct signature from a different installation is rejected, then the real holder finds the nonce spent: tests/challenge-auth.test.mjs:586-599. |
| Unenrolled answer succeeds | PASS — open challenge, valid signature, 403 not_enrolled, zero session/store change: tests/challenge-auth.test.mjs:613-627. |
| Private-key bytes leak | PASS for code and counted wire/stderr scan — signer returns a signature only: server/keys.mjs:181-204; test scans PEM markers and key-file body lines across captured request/response bodies and stderr: tests/challenge-auth.test.mjs:1095-1127. |
| Local wire shape changes | PASS — the client test checks the local request body is exactly public_key with a Bearer header: tests/challenge-auth.test.mjs:847-902; the local handler only adds its store write after credential validation: server/api/server.mjs:239-245. |
| Rejection writes enrollment, claims, or session | FINDING F-3 — challenge refusals are checked; the wrong-token local test uses an already-enrolled key, so the idempotent insert masks an early write. |
| Session TTL, entropy, or registry diverges | PASS — both paths issue through the same registry: server/api/server.mjs:243-245 and :303-306; row 14 covers sliding TTL, shared capacity, and revoke: tests/challenge-auth.test.mjs:743-818. SESSION_TTL_SECONDS remains 12 hours and is literal-pinned: server/constants.mjs:36 and tests/constants.test.mjs:166-176. |
| Challenge limit/error status is duplicated or outside constants | Current source PASS — bounds are imported by name and new error statuses are registered centrally: server/api/challenge.mjs:22-31, server/api/server.mjs:292-306, and server/constants.mjs:222-264. Test protection is FINDING F-4. |
| Declared-remote branch touches/presents the local token | FINDING F-1 — ensureServer’s return path loads it unconditionally and its reuse proof presents it. |

**Never**

- PASS — /api/auth/enroll stays unregistered and answers 404: server/api/routes.mjs:70 and tests/api-host.test.mjs:604-614.
- PASS — no route/request field was added or reclassified; only implemented marks and response nonce were added: server/api/routes.mjs:78-79 and :136-158; tests/api-contract.test.mjs:229-253.
- PASS — no configured URL, HTTPS policy, remote bootstrap, trust-matrix cell, MCP schema, or viewer change appears in the baseline diff. The unchanged-path check was git diff --name-only c47141d04c5daafdcd45fad0a9e649f6acb28d7a HEAD; server/mcp-stdio.mjs, web/*, and docs/epics.md were absent. The additional workflow diff does not change the authentication contract.
- PASS — challenge registry state is in memory; enrollment alone is durable: server/api/challenge.mjs:42-44 and server/store/room-log.mjs:435-449. SESSION_TTL_SECONDS is unchanged at server/constants.mjs:36.
- PASS — existing fingerprint helper is reused: server/api/server.mjs:241-245 and :303-306. No .skip/.only/todo matches were found in the touched test files (rg search exited 1 with no matches). No Story 4.2, 4.3, or cross-machine behavior is implemented by these changes.

**I/O & Edge-Case Matrix**

| Row | Result and genuine assertion |
|---|---|
| 1. Fresh nonce and malformed public key | PASS — exact result field, byte length, >=16 entropy, freshness, and malformed-input zero store-state are asserted: tests/challenge-auth.test.mjs:448-472. Exact constant value lacks an independent oracle (F-4). |
| 2. Enrolled answer authenticates actor routes | PASS — token shape, same registry, bind, presence fingerprint: tests/challenge-auth.test.mjs:487-513. |
| 3. Replay fails with no second token/state | PASS — exact request resent, count/hash unchanged: tests/challenge-auth.test.mjs:535-548. |
| 4. Cross-key answer | PASS — valid signature from foreign key rejected: tests/challenge-auth.test.mjs:586-599. |
| 5. 60-second expiry | PASS behavior — injectable clock checks one millisecond before and exactly at bound: tests/challenge-auth.test.mjs:332-349. Literal duration is not independently pinned (F-4). |
| 6. Consume before verify | PASS — wrong signature gives signature_invalid; correct retry gives challenge_invalid: tests/challenge-auth.test.mjs:550-562. |
| 7. Unenrolled key | PASS — challenge succeeds; signed answer is 403 not_enrolled and state stays unchanged: tests/challenge-auth.test.mjs:613-632. |
| 8. Local enrollment/restart | PASS restart durability and nonce loss over spawned children: tests/challenge-auth.test.mjs:679-740. Rejected-local subcase is FINDING F-3 because its key already has a row. |
| 9. Bounded nonce set | PASS — default capacity and oldest eviction are asserted: tests/challenge-auth.test.mjs:360-390. Exact capacity lacks an independent oracle (F-4). |
| 10. Declared-remote client and DM exchange | FINDING F-1 — normal-path no-local-auth request is asserted, and real client DM send/read works: tests/challenge-auth.test.mjs:847-928; helper token access/recovery is untested. FINDING F-2 — remote is asserted after success, but also after not_enrolled at :930-941. |
| 11. Private key never travels | PASS — counted scans across captured request/response bodies and server stderr plus exact wire-field vocabulary: tests/challenge-auth.test.mjs:1095-1156. |
| 12. Plugin-data deletion | PASS — unrelated fingerprint, not_enrolled until enrolled, only Broadcast Room, no realms directory, one 0600 key: tests/challenge-auth.test.mjs:994-1024. |
| 13. NFR-3 wire mirror | PASS — session actor_fingerprint, message sender_fingerprint, and answer public_key are each rejected as unknown_field: tests/challenge-auth.test.mjs:1046-1087; pipeline runs the unknown-field gate before the handler at server/api/pipeline.mjs:425-439. |
| 14. Shared session semantics | PASS — injectable sliding TTL, capacity across both paths, and revoke for challenge-issued tokens: tests/challenge-auth.test.mjs:743-818. |

## 2. Store/API invariants — PASS, with F-1 and F-2

The route table keeps the exact frozen fields and enroll unregistered. Both issuance handlers use the effective shared session registry. The additive enrollment table has IF NOT EXISTS convergence, exact ordered columns, STRICT verification, and no version increment; enrollActor is idempotent and preserves the first enrolled_at. The local handler checks the token before writing, but its negative test is weak as described in F-3. The answer handler never reads public_key. Four challenge bounds and three statuses/messages currently have one production home; the tests do not lock the four numeric values or guard against duplicate literals (F-4). loadOrCreateKeypair returns no private bytes; signWithInstallationKey returns only a signature. Nonces and sessions remain in-memory; enrollment is SQLite durable. The changed client branch is keyed on declared remote mode and has no authenticate fallback, but ensureServer violates the broader no-token-touch contract (F-1). SESSION_TTL_SECONDS is still 12 hours.

## 3. Tests’ ability to fail — FINDINGS F-1, F-3, F-4, F-5

The new suite uses real HTTP and SQLite state with no wire fake; its observation wrapper delegates requests to the real node:http implementation at tests/challenge-auth.test.mjs:93-127. It uses the real createAgentRoomClient at :854-873. Child-process tests exist, but rows 2, 3, 4, 7, and 13 use in-process startServer calls (F-5). Replay, cross-key binding with a correct foreign signature, consume-before-verify order, unenrolled answer gating, restart persistence, oldest eviction, no normal-path local-auth request, key-material scans, FR-3 rooms, and the three unknown-field routes all have direct assertions.

The suite would catch a replay token, a cross-key acceptance, nonces persisted across the tested process restart, answer acceptance of the public_key smuggling request, and an ordinary-path local-auth fallback. It would not catch a local-token read during bootstrap or the half-stale local-token proof (F-1); it would not catch rejected enrollment of a previously unenrolled key (F-3); and it would not pin challenge-bound drift or an identical limit literal copied outside constants (F-4).

Tests were not executed; this is a source-and-test inspection only.

TEAM_DONE story-4-1-audit-luna
