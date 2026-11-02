# แผนย้าย agent-room สู่ DDD bounded contexts — draft for review

**สถานะ:** Draft for operator review — NOT implementation authorization. Two read-only advisor reviews completed (codex `gpt-6.1-sol[ultra]`, agy `gemini-3.8-flash-high`, both identity matched); requirement-audit was invoked, but no auditable report was returned into this work record, so do not treat the plan as requirement-audit PASS. Detailed advisor blockers are appended below.  
**ฐาน:** source tree/package metadata v0.7.0; HTTP/MCP/CLI/file/SQLite contracts are the compatibility baseline. Release-registry/production bytes were not re-verified in this planning review.  
**เหตุผล:** Operator ระบุ 3 ขอบเขตที่ควรแยก: ยืนยันตัวตน (Identity), ส่งข้อความ (Messaging), แจ้งเตือน (Notification). แผนแยก *เจ้าของกฎและ dependency* ก่อนแยก process หรือ database.

> **หลัก:** bounded context = เจ้าของ model และ invariant ไม่ใช่แค่ folder. รักษา modular monolith, Node built-ins, one SQLite database, MCP/HTTP/CLI surfaces เดิม. ย้ายทีละ slice ที่ให้ผลตรวจวัดได้. ไม่เปลี่ยนกติกาธุรกิจเพียงเพื่อให้แผนภาพสวย.

## 1. เป้าหมายและเส้นห้ามข้าม

### เป้าหมาย

1. แต่ละ context เป็นเจ้าของกฎ/ข้อมูลของตน; context อื่นเรียกผ่าน public operations/ports ไม่แตะ mutable internals.
2. รักษา chat behavior v0.7.0: durable ordered log, idempotent send, client-side trust/held, first-contact wake + 300 s repeat cooldown + 10/min installation budget, body ไม่รั่วจาก held path.
3. ให้ Identity เป็นเจ้าของ session/claim/fence implementation แต่คง **fence enforcement points เดิม** ที่ auth/stage, post-input revalidation ก่อน mutating handler, และทุก long-poll iteration. ย้ายเจ้าของกฎไม่ใช่ย้ายจุดตรวจ.
4. แยก Notification's observed/wake progress จาก Messaging's consumed/read cursor; ห้ามรวมให้เหลือตัวเลขเดียว.
5. ลด coupling ที่ตรวจได้ด้วย import graph, test seams, targeted AC—not LOC หรือจำนวน folder.

### Non-goals / decisions not authorized by this plan

- ไม่ลบ one-live-session-per-Chat-ID, lease, occupancy generation, conflict tickets, takeover, fencing. Retirement ต้องมี product decision ว่า alias เดียวหลาย live sessions ทำงานอย่างไร (addressing, attribution, duplicate sends, reconnect/hand-off).
- ไม่ย้าย allowlist/held policy ไป server; fingerprint-specific allowlist ยังคง per-installation/per-realm.
- ไม่เปลี่ยน SQLite schema, HTTP/MCP tool names/payloads, error envelopes, CLI grammar, invite/auth format, inbox JSONL schema, `wake-state.json` format ใน structural phases.
- ไม่เพิ่ม external runtime packages, microservices, unix sockets, event broker, network calls ระหว่าง contexts.
- ไม่อ้าง notifier-on soak qualification: REL-3 FD corridor ยัง calibrated สำหรับ pull-only clients; soak children คง `AGENT_ROOM_NOTIFIER=off` จนกว่าจะมีการ calibrate และอนุมัติ gate แยก.

## 2. Bounded-context map (เจ้าของกฎ ไม่ใช่ deployment diagram)

| Context | เป็นเจ้าของ | Public contract ให้ context อื่น | ห้ามทำ |
|---|---|---|---|
| **Identity & Admission** | key enrollment/challenge, Actor fingerprint, realm membership/admission, invite issuance/consumption, Chat-ID directory claims/ambiguity, live sessions/leases/occupancy/takeover, bans, presence projection, supersession/fence state | `AuthenticatedPrincipal`; synchronous checks สำหรับ current session/fence และ admission; room-address resolution; presence projection | ไม่เก็บ room/message content; ไม่ตัดสิน client-side allowlist; ไม่ย้าย fence check ออกจากตำแหน่งเดิม |
| **Messaging** | room/direct membership, append-only message rows, sequence/page ordering, send idempotency, read-page authorization; consumed/read cursor on client | operations `append`, `readPage`, `listRooms`, `openDirect`; ordered page พร้อม seq; ส่ง actor/session assertion ผ่าน Identity port | ไม่รู้ ticket/generation/lease internals; ไม่เขียน trust state; ไม่ถือ wake cursor. HTTP envelope + actor-wide request admission อยู่ outer API composition เพราะครอบ Identity routes ด้วย; send-specific bucket อยู่ Messaging-side composition |
| **Client Delivery Policy** *(subdomain ภายใน Messaging edge ไม่ใช่ server context ใหม่)* | receiver-specific allowlist, trust evaluation, held marker/cache, body envelope/sanitization | `DeliveryVerdict` per row: deliver/held + held metadata only | ไม่ส่ง held body ไป inbox/hook/wake; ไม่เปลี่ยน server log; ไม่เชื่อ Chat ID เป็น identity |
| **Notification** | room watcher scheduling, observed/wake progress, first-contact/cooldown/budget policy, `wake-state.json`, inbox/hook/wait hint adapters | `WakeHint` metadata-only; ไม่มี read acknowledgment | ไม่ advance Messaging consumed cursor; ไม่รับรอง host wake/at-least-once delivery; ไม่ bypass client trust classification |

**Context map:** Identity → validated principal/admission → Messaging. Messaging → ordered pages → client delivery classification → Notification. Notification → host wake hint only; agent อ่านต่อผ่าน `message_read`. Identity และ Messaging ไม่ import Notification.

### สำคัญ: 3 progress values ไม่ใช่ duplicate cursor

- **Consumed-through** — adapter cursor หลัง agent ประมวล `message_read`; Messaging consumer state.
- **Observed-through** — watcher เคย scan/hint ถึง seq ไหน; Notification state.
- **Wait baseline** — จุดเริ่มของ CLI wait (จาก consumed cursor หรือ 0); process-local observation สำหรับหนึ่ง wait.

เป้าหมายคือ **ใช้ scan/classification contract ร่วมกัน** เมื่อ semantics ตรงกัน แต่ห้ามเขียน observed seq ทับ consumed cursor. ยังต้องพิสูจน์ disk/memory disagreement, concurrent notifier+CLI และการล้มเหลวระหว่าง persistence.

## 3. Current-state source map (ตรวจจาก code, v0.7.0)

- Identity core: `server/api/challenge.mjs`, `server/api/local-token.mjs`, `server/api/enroll-rate-limit.mjs`, `server/store/invites.mjs`, `server/store/bans.mjs`, `server/core/session-registry.mjs`, `server/api/session.mjs`, `server/api/conflict-tickets.mjs`, presence/claim handlers in `server/api/server.mjs`.
- Cross-context enforcement: `server/api/pipeline.mjs` pins request at auth, checks supersession through stages, revalidates after body/input resolution immediately before mutating handler; `server/api/server.mjs` rechecks supersession + ban inside each long-poll iteration. These are security invariants, not accidental plumbing.
- Messaging core: message/room routes in `server/api/server.mjs`; persistence/migrations/room membership/messages/claims currently share `server/store/room-log.mjs`; budgets `server/api/rate-gates.mjs`; storage gate `server/store/storage-gate.mjs`.
- Client delivery: `server/client/trust.mjs`, `server/client/held.mjs`, `server/client/api-client.mjs` (auth + earned transport/reconnect + messages + consumed cursor + envelope + trust application), `server/mcp-stdio.mjs`. The v0.7 wait trust omission was fixed in this migration work and covered by `tests/wait-command.test.mjs` Local, configured HTTPS and declared-remote-loopback cases; preserve those as regression tests.
- Notification current in this worktree: implementation moved to `server/notification/notifier.mjs` and `wake-policy.mjs`; old `server/client/` paths are compatibility re-exports; `mcp-stdio.mjs` starts the new context directly; `wait-commands.mjs` imports its wake policy and applies local DeliveryVerdict before wake. `tests/ddd-boundaries.test.mjs` currently enforces Notification's allowed client adapter imports and asserts Identity/Messaging directories are not yet extracted. These are current phase facts, not future proposals.
- Existing artifact state: v0.7.0 release remains historical baseline; current DDD migration worktree has local source changes pending gates. `docs/statechart/ddd/` contains reduced models; their abstractions/omissions are explicit and they are not full runtime proofs.

## 4. Migration sequence — one deliverable per phase

No phase begins until the previous phase's AC, targeted tests and full suite are green. Each phase gets its own PR/release decision; phases do not imply permission to change the wire contract.

### Phase 0 — Baseline + architecture contract (docs/tests only)

**Deliverable:** this approved context map; import/dependency map; frozen behavior inventory; test baseline.  
**Stories:**

- **0.1 Freeze external contracts.** Record every MCP/HTTP/CLI payload/error, event, file format, and compatibility promise touched by the context seams. AC: contract fixtures exist or exact existing tests are referenced; no source/runtime bytes change in this phase.
- **0.2 Name invariants by owner.** Identity: principal authenticates; only same Actor explicit ticket takeover; persist claim before memory transfer; fence at three existing check points. Messaging: append/idempotency/sequence/membership unchanged. Client policy: held bodies never leave path. Notification: first-contact wake, cooldown, budget; suppressed rows never consume; wake != read acknowledgment. AC: each invariant links to an existing runnable test or is labeled a new test requirement.
- **0.3 Dependency rule (ratcheted).** Record current import edges/callers and define the target direction. Automated test initially forbids new cross-boundary private imports; each extraction removes named existing edges. It must fail on a deliberate forbidden import and pass on documented temporary adapters. Final target: entrypoints/outer composition may call contexts; Messaging → Identity public port only; Notification → current client transport adapter until Messaging port exists, then Messaging page port + client DeliveryVerdict; no Identity/Messaging → Notification; contexts cannot import another context's private repository. AC: positive/negative fixtures for the rule and an explicit allowlist of transitional edges with owner + removal phase.

**Gate:** no public behavior change; record actual baseline using `node --test --test-concurrency=1` (include Node version, pass/fail/skip, duration, and exact commit); strict validation on a freshly materialized package. Establish import-graph baseline and CI rule as a ratchet (capture existing mixed edges, forbid new ones, then remove one edge per approved slice); do NOT require the final future graph before temporary adapters/ports exist. Release digests remain historical evidence, never proof of changed bytes.

### Phase 1 — Notification correctness boundary (first code extraction)

**Goal:** make the two wake substrates share honest, race-safe behavior before moving them behind one context.

- **1.1 Correctness fix before extraction (confirmed v0.7.0 defect).** The wait CLI reads raw HTTP rows; the server page has no client-local `held` field. `row.held === true` is therefore not a trust verdict and wait currently skips neither client classification nor cooldown. Apply the receiving installation's existing `evaluateSender`/`applyTrustMatrix` using its actual fingerprint, transport mode, realm allowlist and accept-all setting before wake eligibility. **Behavior changes:** wait must now suppress repeated untrusted wakes (and held first-contact may consume the held wake cooldown/budget); trusted sends remain ungated. Preserve own-fingerprint skip, hint-only output and the log/cursor. Record old/new behavior, error policy and release-note text; this is a correctness fix, not a structural-only move. Test actual CLI stdout for local transport, configured remote transport, declared remote-on-loopback, allowlisted fingerprint, accept-all, untrusted held sender, corrupt allowlist, allowlist removal during wait, same Chat ID/different fingerprint; assert body never appears in wait stdout. Existing source seams: `server/client/trust.mjs:evaluateSender/applyTrustMatrix`; wait must receive earned client transport + realm identity from the existing auth/config path, not guess from URL or Chat ID.
- **1.2 Separate pure classification from side effects.** Shared helper may normalize ordered rows, skip own fingerprint and return a client `DeliveryVerdict`; it MUST NOT reserve cooldown/budget or write files. Keep notifier's per-row JSONL + trusted preview semantics and wait's first eligible metadata hint semantics. Preserve Notification's observed watermark separately from consumed cursor. A losing room in wait's `firstHit` race must not spend another room's sender grant; define cancellation/settlement before policy mutation.
- **1.3 Wake-ledger failure decision gate (BLOCKER before claiming aggregate cap).** v0.7.0 uses read/decide/atomic-rename without cross-process serialization; `atomicWriteJson` protects file replacement, not the decision transaction. Its current policy is fail-open on corrupt/missing state and write failure; keep this behavior until a product/security decision explicitly changes it. Before implementation, provide a decision table for missing/corrupt/unreadable/permission-denied/ENOSPC/write failure/lock contention/crash: whether a wake is emitted, cooldown/budget is charged, what diagnostic is recorded, and what aggregate guarantee remains. Do NOT promise a hard 10/60 cap while the ledger is degraded. Any chosen lock protocol must state stale-owner recovery, PID reuse/EPERM behavior, owner-only modes, bounded acquisition, crash recovery, and mixed-version writer policy; no blind TTL lock or sleep loop without proof. Prune `perSender` entries older than the effective cooldown and bound JSON bytes/entries; budget timestamps older than the effective window are pruned. Define mixed env overrides (MCP and CLI sharing one ledger with different cooldown/window settings) and clock rollback/future timestamps. Benchmark only after fixing fixture and choose p95 threshold from measured baseline; 50 ms lock timeout is a proposal requiring a latency/behavior decision, not an accepted fact.
- **1.4 Keep defaults and compatibility.** Existing `wake-state.json` is v0.7.0 state. Any format migration must be additive/read-compatible, atomic, 0600, rollback-safe. Old/new binaries must not concurrently write an incompatible ledger: define stop/restart handoff or compatible versioned protocol before mixed-version rollout. No migration may reset cooldown/budget silently.
- **1.5 Integration tests.** Spawn MCP notifier + CLI wait simultaneously against one receiver installation. Drive first held, repeat, many distinct senders, trusted send, notifier off, crash/restart, corrupt state, ENOSPC, allowlist change, and mixed-version/env cases. Assert actual user-visible inbox/hook/stdout outputs (not only grants), per-row trusted preview, no held body, no lost/double grants under healthy ledger, deterministic degraded behavior when ledger fails, losing wait rooms do not spend budget, suppressed held rows remain retrievable and do not move consumed cursor.

**Gate:** observed HTTP request budget unchanged; cross-process race/fault tests pass; state migration/rollback is demonstrated on copied client data; full suite + fresh package/strict validation. If no bounded, crash-safe, cross-process synchronization fits the current platform constraints, stop for a separate ADR and do not claim aggregate-budget enforcement.

### Phase 2 — Notification bounded context (modular monolith)

**Deliverable:** Notification module owns watcher scheduling, wake policy, observed progress, inbox/hook and wait hint adapters. **Do not create a formal port to a not-yet-extracted Messaging context in this phase.** Wrap the current `ApiClient`/HTTP behavior behind an internal local adapter; record this as transitional and name the Phase 4 replacement seam. No speculative API framework.

- **2.1 Move notifier behavior behind a small constructor/adapter.** MCP stdio retains first-successful-call start, `room_direct_open` kick and shared shutdown; Notification receives a narrow adapter over the EXISTING `ApiClient` (`listRooms`, `readMessage`, realm/fingerprint/transport). Preserve STOP_CODES, teardown/abort, request pacing, 20-room/24 h rule, 0600 inbox, per-row JSONL fields/trusted preview/held empty-preview, and `execFile` no shell.
- **2.2 Make CLI wait an adapter over the same pure classifier/scan rules.** Preserve CLI grammar, exit codes, unbound session, 6 concurrent holds, overflow head check, own-send skip, unread backlog baseline, deadline and metadata-only stdout. Wait must apply local trust; do not infer held state from raw HTTP fields. Keep wait's baseline behavior separate from notifier-observed and MCP-consumed progress.
- **2.3 Define wake hint semantics.** Notifier emits each eligible row (trusted preview retained); wait emits one first eligible seq per invocation. In the concurrent wait race, only the winning room may commit a wake grant/output; losers are aborted/drained or must prove their policy decision has no externally visible charge. A failed inbox/hook/stdout path has the Phase 1 failure semantics; do not claim exactly-once delivery.
- **2.4 Compatibility proof.** Before/after golden tests for MCP tool schema, HTTP route envelopes, CLI JSON output, inbox JSONL schema/mode/field cardinality, trusted preview and held-empty preview, env flags; no new server API or DB migration.

**Rollback:** keep thin adapters at old import paths for one release if necessary; they delegate only (no parallel implementation). Any retained behavior-changing trust fix/cooldown is identified separately from the module move, with regression and release note. If caller behavior differs, revert the slice, not trust/wake policy silently.

### Phase 3 — Identity ownership and the sender seam

**Deliverable:** `server/identity/` owns enrollment, principal/session/claim operations, bans and presence projection. Preserve APIs and state.

- **3.1 Define an Identity admission capability, not just a static principal DTO.** A `ValidatedPrincipal` alone does not pin a request against supersession. Public synchronous operations (names are illustrative; signatures/error mapping are frozen in the story) must cover: `enterInFlight(sessionKey)` synchronously with successful auth before the first post-auth await; `isSessionSuperseded(sessionKey): boolean` at the existing authz stage; a **fence-only** `isSessionSuperseded(sessionKey)` immediately after input/body resolves and directly before mutating handler (no await between); `leaveInFlight(sessionKey)` exactly once in `finally`, including thrown/rejected handlers; `isActorBanned(actorFingerprint)` at authz stage in the existing precedence and freshly on every long-poll iteration. Do not add a ban recheck at post-input; do not refresh token TTL/presence/request budget per poll; retain auth verification side-effects/order and error vocabulary. For send, obtain current live session attribution synchronously at handler entry; requested Chat ID must still match and stored `chat_id` remains live display value.
- **3.2 Extract session/claim/ticket orchestration only after 3.1 tests pass.** Keep observe→ticket redeem→occupancy compare→durable claim persist→memory transfer→supersede order. Ticket redemption is single-use and occurs before transfer persistence; if persistence fails, incumbent remains and ticket is burned—fresh plain bind must mint a new observation. Wrong Actor/name does not burn rightful ticket. Preserve TTL/scope, zero-ABA generation, bounded ticket store and restart invalidation.
- **3.3 Extract challenge/enrollment/invites/bans/presence incrementally.** Keep existing endpoints, invite token format, rate gates and SQLite tables. Explicitly inventory invite_consumptions and transaction coupling (invite consume + enrollment insert + ban gate); preserve challenge behavior for banned keys and proof-before-consume. Presence remains a projection (online != available/wakeable); it never frees occupancy. Route/API adapter translates Identity domain outcomes to existing wire envelopes so context does not import API/pipeline rejection helpers.
- **3.4 Identity adversarial tests.** Named regression set: `tests/session-routes.test.mjs`, `session-replacement.test.mjs` (delayed-body fence, auth pin, every exit, same-key concurrency, ticket burn/write failure), `presence.test.mjs`, `direct-open.test.mjs`, `messages-api.test.mjs` (rename/disconnect attribution), `invites.test.mjs`, `ban.test.mjs` (fresh ban per poll, unban with existing token), `challenge-auth.test.mjs`, `local-auth.test.mjs`. Add port-level tests for each checkpoint, ban/fence precedence, auth TTL/touch failure effects, foreign collision confidentiality, stale ticket/zero-ABA, persistence failure and in-flight request pin survival.

**Gate:** no handoff/fence enforcement point moves; no accepted request gains a body-arrival window; no session/claim/ticket behavior change. Dependency test proves Messaging imports Identity public port only, never `session-registry.mjs`/`conflict-tickets.mjs`; API composition owns wire mapping. All old negative/positive checkpoint tests still pass.

### Phase 4 — Messaging ownership and SQLite module boundary

**Deliverable:** `server/messaging/` owns room and message application operations; `server/store/` has Identity and Messaging repository modules over the SAME `DatabaseSync` and SAME physical SQLite file.

- **4.1 Freeze active schema + composition root.** `server/database.mjs` is legacy; active DB is `agent-room.sqlite`, `user_version=2`. Active tables: Identity=`realms`, `enrolled_actors`, `chat_id_claims`, `banned_actors`, `invites`, `invite_consumptions`; Messaging=`rooms`, `direct_members`, `messages`. No cross-context FKs/joins in the message path were found; claims are used by directory resolution before direct-room open. Bans/invites already accept shared DB operations. Keep the one runtime `DatabaseSync`, WAL/FULL/foreign-key setup, schema convergence and migrations owned by one composition root; migration runner may use a temporary dedicated connection at startup and must remain the sole v1→v2 owner.
- **4.2 Extract Messaging repository operations** from `room-log.mjs`: append, idempotency tuple, readPage/headSeq, rooms/membership/direct pair. Preserve STRICT/WAL/FULL/foreign keys, same-version v2 convergence, v1 migration, indexes, transactions and every refusal/side-effect order. Schema owners never create nested `BEGIN` or close a shared connection.
- **4.3 Extract Identity repository modules** for claims/enrollment, bans, invites/consumptions, and realm metadata while staying on the same connection. Keep invite consumption + enrollment insert + ban gate transaction atomic. The active call inventory includes CLI ban/invite, API server bootstrap, viewer (claims/presence), presence and direct-open—not only actor message routes. No Messaging module may query Identity tables; directory resolution is an Identity operation composed before Messaging openDirect. Identity APIs return typed domain outcomes; outer API/CLI/viewer adapters own wire/console mapping.
- **4.4 Migration/rollback tests.** Empty v2, populated v2, same-version legacy-v2 convergence, v1 migration no-op/retry/failure, corrupt/future/foreign/symlink refusal, partial bootstrap and populated old-client-state fixtures. Run N package operations, stop, then materialize/open/read/retry with N−1 package against a **copy of current DB + client state**; do not rollback by mounting a stale data backup over acknowledged writes. If schema must change, separate migration ADR, backup/restore proof and compatibility window before coding.

**Gate:** active table/caller inventory complete; migration fixtures and operation-order tests pass; `PRAGMA integrity_check`, idempotent restart, all store/CLI/viewer callers, release-package smoke and full suite pass. No table rename/drop, no second runtime database and no context-owned independent connection lifecycle in this phase.

### Phase 5 — Boundary hardening and steady-state

- **5.1 Remove transitional delegates** only after import graph shows no legacy caller and contract tests cover each entrypoint.
- **5.2 Run dependency-direction check and owner tests in CI.** Each context owns pure unit tests; cross-context contracts use narrow real adapters; end-to-end suite verifies MCP/HTTP/CLI together.
- **5.3 Requalify operational profile.** If notifier is enabled during REL-3, first calibrate FD envelope against v0.7.0 baseline, then freeze limits and fixtures, then run the soak on a quiet host; do not claim notifier-on qualification until this passes.
- **5.4 Retirement proposal is separate.** Only after product evidence for alias multi-session semantics, explicit operator decision, migration/rollback design, and session/fence replacement model. No v0.8/major assumption embedded here.

## 5. Cross-cutting acceptance contract (every implementation phase)

1. **Behavior:** existing clients continue sending/reading mid-conversation; no force re-enrollment, room rename, token reset, message loss/duplication, or silent trust change.
2. **Security:** Identity principal from installed key only; no caller-supplied `actor_id`; no raw credentials in logs/artifacts; held body never appears in Notification output; all files owner-only; viewer stays GET-only.
3. **Ordering/atomicity:** append + idempotency invariant unchanged; durable claim persists before live bind commit; fence checks remain synchronous at existing points; a held row is not consumed by a wake.
4. **Performance:** retain API request gate **120/min/key, burst 30** (`REQUEST_BUDGET_BURST`); the separate new-send bucket has capacity 10 and refills at 0.5/s (`SEND_TOKEN_CAPACITY`), so do not mix these two gates. Preserve notifier start spacing 600 ms; ≤6 concurrent wait holds, each server hold ≤20 s; no new remote round-trip per message. Do not adopt a p95 local wake-state budget until Phase 0 records a reproducible benchmark fixture (host, filesystem, ledger size, concurrency, sample count); then set a measurable regression threshold from baseline + agreed margin, not an unsupported 10 ms target.
5. **Failure:** remote down follows existing reconnect schedule; wake-state read/write failure has an explicit policy and telemetry; timeout/cancel shuts down holds; corruption recovery does not erase trusted/consumed state; rollback never overwrites the database.
6. **Evidence:** focused tests, integration path, serial full suite `node --test`, package-release materialization + strict validation; changed package bytes get new digest/candidate. TLA only claims the modeled state/order properties and names omissions (time, concurrency, I/O).

## 6. Rollback and release discipline

- Source-only structural refactor with identical package behavior: still create a new candidate/digest and run full tests/strict validator; never reuse old tree digest as proof of new bytes.
- Any local `PLUGIN_DATA` state format change: read old format first, atomic write new format, preserve backup/rollback reader for at least one release; test corrupt/truncated/permission-denied/ENOSPC paths.
- Any SQLite schema change: stop before implementation unless separate migration/restore plan exists; never reverse a migration in place without tested backup restore.
- Any wire/output change: treated as behavior change, compatibility tests + explicit versioning decision, never smuggled in as DDD cleanup.
- Production deployment: deploy only published artifact; keep prior container/data mount for rollback; health/version + SQLite integrity check after swap.

## 7. Requirement-audit checklist (execution gate)

Every implementable story extracted from these phases must state the target caller, allowed inputs, outcomes/errors, timeout/retry/atomicity, trust boundary, scale/latency budget, external interfaces/files touched, executable AC, tests and rollback. The current plan is an epic-level migration plan—not a sprint-ready ticket set. Missing business decision (multi-session aliases) remains explicitly deferred, not guessed.

## 8. Advisor review (2026-11-01) — two independent read-only rounds

Reviewers: codex `gpt-6.1-sol[ultra]` and agy `gemini-3.8-flash-high`, both identity-matched and seated as the Anti-Consensus Club. Full outboxes: `.mailbox-out/ddd-plan-codex`, `.mailbox-out/ddd-plan-agy` (local repo history; not part of the published artifact unless explicitly attached).

### Findings both lanes agree on (blockers to a safe implementation backlog)

1. **Wait CLI trust-classification defect must be a correctness fix, not a structural “verify”.** Server pages return raw message rows; `row.held` is client-local and is absent on raw wait responses. The wait CLI currently checks `row.held` before cooldown, so that branch cannot classify untrusted rows. Phase 1.1 now explicitly says client-side `evaluateSender/applyTrustMatrix`, uses actual transport/realm/allowlist/accept-all, tests local + remote + declared-remote-on-loopback, and records this as behavior change with release notes. Evidence: `server/cli/wait-commands.mjs`, `server/api/server.mjs` read route, `server/client/trust.mjs`.
2. **The wake ledger is TOCTOU across the two processes.** `atomicWriteJson` makes replacement atomic but does not serialize read→decide→write; the 10/60 aggregate budget and per-sender cooldown are best-effort under concurrent notifier + wait. `perSender` has no bounded retention. Plan Phase 1.3 now makes failure semantics, locking protocol, pruning/byte bounds, mixed policy envs, clock skew, and cross-process tests a precondition. Until passed, do NOT promise hard cap. Current code is fail-open on corrupt/missing ledger and write failure; the plan keeps that behavior pending a product/security decision.
3. **Identity needs an admission capability, not a static principal alone.** Pin at successful auth before the first post-auth await; synchronous fence checks at authz and post-input-before-handler; synchronous ban check at authz and each poll iteration; release pin exactly once in finally. Post-input is fence-only; do not add ban/token-live/TTL check there. Send attribution must be checked against the live session at handler entry. Phase 3.1 now enumerates those contracts and regression groups.
4. **SQLite is one active runtime DB, but ownership/composition is split across modules already.** Active file is `agent-room.sqlite`, schema v2; active tables include Identity `realms/enrolled_actors/chat_id_claims/banned_actors/invites/invite_consumptions` and Messaging `rooms/direct_members/messages`. `bans.mjs` and `invites.mjs` already accept shared DB operations; startup migration has its own temporary connection. No cross-context SQL join was found in message operations. Phase 4 now lists all active tables/callers and preserves one runtime connection/schema owner; no second DB.
5. **Composition owner is outside the three contexts.** HTTP body parsing, shared envelope, actor-wide request budget, route composition and wire mapping must remain an outer API/entrypoint layer. Send-specific budget belongs with Messaging; request gate applies to Identity endpoints too. Do not make Identity depend on Messaging to reuse generic pipeline code.
6. **Rollback means run prior code against current acknowledged data, not remount stale DB backup.** Test N→N−1 package on a copy of current DB + client state; keep the single schema/bootstrap owner; do not silently reset cooldowns or cursor state.

### Warnings/precision edits incorporated

- Request gate is 120/min/key, **burst 30**. New-send token bucket is separate: capacity 10, refill 0.5/s. Prior draft confused their burst values; corrected in cross-cutting performance contract.
- Trusted messages produce one JSONL/hook line per delivered row with bounded preview; HELD lines have empty preview. Wait is one metadata hint per invocation. “No body leakage” means no HELD body in any wake surface—not “all Notification outputs are body-free”.
- Keep truthful semantics if notifier append/hook fails or wait loses a multi-room race: state grant vs visible output must be specified; do not imply exactly-once wake. Do not charge losing wait attempts; cancel/drain losers.
- Phase 2 uses a local adapter over current `ApiClient`; no formal Messaging port until its provider exists in Phase 4. Phase 0 import gate is a ratchet with explicit temporary edges, not a premature requirement that the final graph already exists.
- Store split acceptance must test send order/transaction (idempotency, duplicate, reply validation, storage gate, sequence/insert), post-commit failure, migrations, same-version convergence and all CLI/viewer/bootstrap callers.
- REL-3 remains notifier-off qualified; source models omit timing, actual cross-process I/O and aggregate budget. Model reports are not runtime proof.

### Reviewer disagreement retained

Agy proposed a bounded advisory lockfile with a 50 ms timeout and fail-open wake fallback; codex emphasized that lock protocol, stale-owner recovery, output/grant ordering and failure guarantees must be decided/proved before asserting a hard budget, and warned a lock can consume cooldown before a visible output. The plan does **not** choose an unproved lock mechanism or adopt 50 ms as an SLA. Phase 1.3 requires a bounded technical spike/ADR comparing minimal options under the project constraints, with outcome table and measured wait budget. Existing fail-open behavior remains until an explicit decision changes it; aggregate cap is not promised in degraded/racy state.

## 9. Requirement-audit result (Grill + INVEST, 2026-11-01)

**Scope:** this migration plan is an epic/work-package set, not yet an implementation-ready backlog. Audit distinguishes plan readiness from story readiness. Advisors found concrete seams; requirement-audit checks whether they are operationally complete.

### Grill — plan-level content

| Dimension | Verdict | Evidence / gap |
|---|---|---|
| 💼 Business / Functional | ⚠️ Partial | Operator, 3 contexts, current chat behavior, non-goals, migration outcome and alias-retirement deferral are explicit. “First-contact wake” is now correctly subject to aggregate held-wake budget; hard cap is not promised until ledger concurrency/failure gate passes. No decision requested on multi-session alias semantics. |
| 🔍 Validation | ⚠️ Partial | Some input/state constraints are exact (fingerprint trust, realm path, env positive integers, old/new state format); each future port/repository story still needs its DTO/schema bounds, mandatory fields, error mapping and invalid-state test matrix before ticketing. |
| ⚠️ Exception | ⚠️ Partial / blocker | Remote-down/reconnect, transaction ordering, corrupt state, ENOSPC, lock contention, crash and rollback are named. Wake ledger policy table, lock acquisition/cancel budget, winner/loser output settlement and API Port timeout budgets remain Phase 1 ADR/AC prerequisites. |
| 🔒 Security | ✅ With explicit gates | No actor_id input; fingerprint authority; client-local trust; held body exclusion; owner-only modes; GET-only viewer; fence points preserved; secret hygiene. Identity pin lifecycle and wait trust classification are mandatory blockers, not “later hardening”. |
| ⚡ Performance | ⚠️ Partial | Existing fixed budgets listed (120/min request, burst 30; new-send bucket 10/0.5s; notifier 600 ms; wait ≤6 × ≤20 s). New state-lock p95 intentionally deferred pending baseline fixture; cross-process contention and output latency must be measured before cap claims. |
| 🔌 Integration | ⚠️ Partial | MCP/HTTP/CLI, ApiClient, SQLite/WAL, inbox/hook, package/release and soak are enumerated. Phase-specific port DTOs, actor-wide outer composition, restart/rollback old-client-data tests and error translation must be made ticket-level AC. |

**Grill verdict:** NOT READY for implementation tickets until Phase 1.3 policy/ADR and Phase 3 Identity port AC are closed. READY to circulate as an architecture work-plan with these blockers visible.

### INVEST — story-shape review

| Work item | I | N | V | E | S | T | Audit |
|---|---|---|---|---|---|---|---|
| 0.1 contracts + 0.2 invariants + 0.3 dependency ratchet | ⚠️ | ✅ | ⚠️ | ⚠️ | ❌ as one phase | ⚠️ | Split into separate docs/fixture, invariant trace, and import-ratchet stories; each can then stand alone. |
| 1.1 client wait trust fix | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ after specified matrix | Concrete user-visible security/wake correction; behavior change disclosed. |
| 1.2 pure scan/classifier | ⚠️ depends on 1.1 | ✅ | ✅ | ⚠️ | ✅ | ✅ | Keep only identical semantics; no side-effecting budget reservation. |
| 1.3 ledger synchronization + failure/retention ADR | ✅ as spike | ✅ | ✅ | ❌ until mechanism chosen | ❌ if lock + policy + prune + telemetry all one ticket | ⚠️ | First deliver an options/measurement ADR; implementation stories only after decision. |
| 1.4 state compatibility | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Gate on old/new writer policy and restart fixtures. |
| 1.5 notifier+wait integration matrix | ⚠️ depends on 1.1/1.3 | ✅ | ✅ | ❌ broad | ❌ | ✅ with named cases | Split concurrency/fault/actual-output matrices; keep real processes. |
| 2.1 notifier extraction | ✅ after 1.x | ✅ | ✅ | ✅ | ⚠️ | ✅ | Bound to one adapter move; preserve output cardinality/preview. |
| 2.2 wait adapter | ✅ after 1.x | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | Explicit cancellation of losers and trust transport provenance. |
| 2.3 wake semantics + 2.4 golden contracts | ✅ | ✅ | ✅ | ⚠️ | ❌ merged | ✅ | Separate policy/compat fixtures from module movement. |
| 3.1 Identity admission capability | ✅ | ✅ | ✅ | ⚠️ | ❌ if API + port + fence rewrite bundled | ✅ when checkpoint matrix is executable | Split port definition/contract tests from call-site migration; preserve synchronous no-await windows. |
| 3.2 bind/ticket transaction | ✅ after 3.1 | ✅ | ✅ | ⚠️ | ❌ | ✅ | Separate ticket observation from persistence-failure/transfer path only if independently releasable without behavior change. |
| 3.3 enrollment/bans/presence | ⚠️ | ✅ | ✅ | ❌ | ❌ | ⚠️ | Split by bounded operation; invite transaction, ban polling, presence projection are distinct. |
| 3.4 adversarial tests | ❌ suite-only | ✅ | ⚠️ | ✅ | ❌ | ✅ | Attach regression tests to the story whose behavior they guard; do not create a test-only phase. |
| 4.1 schema inventory + 4.2 Messaging repo + 4.3 Identity repo + 4.4 migrations | ⚠️ | ✅ | ✅ | ❌ | ❌ as Phase 4 | ⚠️ | Split inventory, repository seam, callers, and migration/rollback fixtures. One schema owner and one connection lifecycle stay invariant. |
| 5.1 delegates + 5.2 CI + 5.3 soak + 5.4 retirement proposal | ⚠️ | ✅ | ⚠️ | ❌ | ❌ | ⚠️ | Not one deliverable. 5.3 requires new calibration gate; 5.4 is a separate business decision, not implementation completion. |

**INVEST verdict:** individual corrective seams (1.1, 1.4, 2.1, 2.2) can become independently valuable stories; multiple phase bullets are too broad or dependent to enter a sprint unchanged. Before execution, split each table row marked ❌ and give it concrete allowed inputs/errors, timeout/rollback and executable AC. The plan deliberately does not create a guessed ticket backlog before the wake-ledger ADR.

### Overall requirement-audit verdict

**NOT READY as an implementation-ready plan/backlog.** It is usable as the reviewed architecture roadmap once the three blockers are resolved: (1) Phase 1.3 ledger protocol/failure decision, (2) Phase 1.1 wait trust correction + first-contact output semantics, (3) Phase 3.1 synchronous Identity pin/check/release contract. Separate the oversized phase bundles into INVEST-sized stories before scheduling. Multi-session alias retirement remains explicitly deferred for the operator; it is not a hidden blocker to behavior-preserving modularization.

## 10. Review provenance and limits

- Codex: `gpt-6.1-sol[ultra]`, identity matched; full read-only report `.mailbox-out/ddd-plan-codex`.
- Agy: `gemini-3.8-flash-high`, identity matched; full read-only report `.mailbox-out/ddd-plan-agy`.
- Audited source snapshot is the v0.7.0 repository at plan-review time. Advisor claims tied to source line references were incorporated. Reviewers did not implement, run full suite, run soak, or verify remote release bytes.
- `requirement-audit` was invoked in audit mode. Its execution returned no separate machine-visible audit artifact; the Grill/INVEST assessment above is the explicit local audit record, not a claimed external auditor PASS.
- Publish status must remain “draft / NOT READY for execution”; publication is private for operator review, not a release or implementation approval.

## 11. Phase 1.3 technical decision: SQLite wake ledger (policy closed 2026-11-02; implementation unverified)

**Policy closure:** `docs/implementation/reviews/wake-ledger-policy-closure.md` supersedes conflicting cold-failure, path-threat, timeout/late-commit and rollback statements in this section. Selected policies: transient cold storage failures may emit at most one degraded hint per process/episode (no aggregate-cap claim); known mismatch, unsafe path and structural corruption refuse; hostile same-UID pathname replacement is out of scope; in-flight deadline with unknown outcome suppresses and never retries; rollback/re-upgrade is a quiesced handoff with an explicit cooldown/budget reset. The AGY round-table's disagreement and the failed Codex follow-up are recorded; no valid three-model review exists. This closes the policy question for a prototype, not its implementation/test gate.


**Candidate selected for planning (not yet implemented):** one client-local SQLite sidecar per installation+realm at `PLUGIN_DATA/realms/<realm>/wake-state.sqlite`, using Node 24 built-in `node:sqlite`; no npm package, server endpoint, Unix socket, or second *server* database. This is an additional client-local state file, not a second server database or service; it increases local file/FD footprint and MUST be included in the measured client resource profile. Do not use JSON read/rename for a cross-process read/decide/write invariant.

### Tables and transaction

- `wake_policy_meta(singleton PK, schema_version, cooldown_ms, budget, window_ms)` — the first initializer writes effective positive bounded values. Every later process reads the stored values; mismatched environment overrides fail closed with actionable `wake_policy_config_mismatch` (do not silently run different policy against one ledger).
- `sender_cooldowns(fingerprint PRIMARY KEY, last_wake_ms)`.
- `held_wakes(id INTEGER PRIMARY KEY, at_ms)` plus index on `at_ms`.
- **Execution thread is a decision gate:** `DatabaseSync` is synchronous and a 50 ms SQLite busy timeout blocks the calling thread. Prototype direct synchronous transaction vs a Node worker thread that owns the ledger DB. Do not call the synchronous option non-blocking. If a worker is used, specify bounded queue length, cancellation, crash/restart and same-process serialization; no external dependency. A 50 ms timeout is only a proposed busy bound; the event-loop or worker-queue impact must be measured.
- **One transaction per eligible decision:** open DB → validate owner-only path → apply bounded busy timeout → `BEGIN IMMEDIATE` → prune expired sender and budget rows → check sender cooldown and aggregate budget → upsert sender time + insert budget row if eligible → COMMIT; rollback on transaction error and close in `finally`. No transaction spans HTTP, inbox append, hook or stdout.
- **Initialization and policy:** only absent DB or supported schema version accepted. Create STRICT schema + metadata transactionally. Import the exact shipped `wake-state.json` v1 schema once; validate version/keys/types; import rows + migration marker atomically. Missing JSON means empty initial state. Corrupt/unsupported JSON follows degraded fail-open policy and does not mark import complete, so retry is possible. Unknown newer SQLite schema refuses without mutation. Do not let “first process to open” silently choose policy: use a deterministic configured policy tuple and require every writer to match stored metadata before mutation. Mismatch is a configuration refusal/diagnostic for notifier and wait, including first contact—explicit exception to “first-contact outranks bookkeeping.”
- **Clock:** use epoch wall time for persistence. Future timestamps are discarded and diagnosed (never extend suppression); backward clock jumps may cause an extra wake, never indefinite suppression. Add tests with injected ±24 h jumps. Cooldown remains best-effort across OS wall-clock correction; monotonic clock is process-local and cannot be the persisted authority.
- **Size/recovery:** select numeric combined DB+WAL+SHM cap from measured page overhead plus maximum policy values; test at cap. On cap/SQLITE_FULL: prune, bounded checkpoint when safe, retry once. If still full, fail-open and emit a throttled diagnostic; never erase active cooldowns or replace DB with empty state. State the exact recovery path (free space/compact/restart) and file-size ceiling before implementation.
- **File discipline:** realm dir 0700; DB/WAL/SHM 0600; validated realm key; race-safe no-follow open or equivalent (pre-open lstat alone is insufficient); test symlink race. SQLite setup MUST match project policy: STRICT tables, WAL, synchronous=FULL, foreign_keys=ON, with busy timeout documented. This is a separate client-local coordination file (not the server DB), increasing client FD/storage footprint; calibrate that footprint before release.

### Explicit degraded-state policy (current v0.7.0 principle retained)

**First eligible contact outranks ledger bookkeeping on storage/lock failure.** On bounded `SQLITE_BUSY`, corrupt/unreadable ledger, ENOSPC, permission failure, or failed commit: emit the otherwise eligible wake, mark the decision degraded, and log one rate-limited diagnostic. Cooldown/budget are not durably charged; the 10-per-window aggregate is guaranteed only for healthy serialized decisions—never claim a hard cap during degraded contention/storage failure. **Policy configuration mismatch is different:** refuse wake-policy initialization before processing any rows (not fail-open) because the processes disagree on what “cooldown” and “budget” mean; surface a stable `wake_policy_config_mismatch` diagnostic and require operator correction. This explicit exception must be user-visible and tested. No fallback JSON writer. Future timestamps are discarded + diagnosed; backward jumps may cause an extra wake, not indefinite suppression.

**Grant/output ordering:** commit the SQLite grant before writing inbox/hook/stdout. A crash or output error after commit can spend cooldown/budget without a visible hint; this is an acknowledged at-most-once signal gap, not exactly-once delivery. Durable message/held rows remain authoritative and are not consumed by Notification. A future outbox would be a separate design, not hidden in this migration.

**Wait loser handling (required correction before grant code):** `holdForRoom` MUST become a side-effect-free probe returning candidate rows + room/seq; it must never call `decideHeldWake`. Run all current probes, order candidate rows deterministically by seq then the CLI's documented room order, classify them using local `DeliveryVerdict`, choose one first eligible result, then reserve exactly one grant and emit the hint. If the candidate is held and suppressed, continue to the next eligible candidate within the same deadline. Only after a winner is reserved may remaining HTTP holds be aborted; await/drain all loser completions before releasing `wait.lock`; loser errors must not spend budget or replace an already selected hint unless a separate fatal-error contract says so. Trusted candidate is never held-budgeted. Assert only the selected candidate can consume cooldown/budget even if losing rooms return later.

### Migration / mixed-version policy

- The currently shipped format is `wake-state.json` version 1 (not “legacy v1”); a future SQLite format must import this exact JSON schema once in a transaction, record migration version, then treat SQLite as sole authority. Keep JSON as a migration snapshot; do not dual-write.
- Before activation, the operator upgrade MUST stop all MCP notifier and wait processes using that `PLUGIN_DATA`, install the new plugin, then restart one MCP host; old JSON writers and new SQLite writers may not concurrently write one installation's wake policy. If the environment cannot enforce/communicate this maintenance handoff, do not activate the SQLite ledger in that rollout.
- The prior wording “retain both files for forensic rollback” was inaccurate: old v0.7 code continues to update JSON, while new code updates SQLite. **Rollback to v0.7 discards cooldown/budget decisions recorded after migration from the old writer’s point of view**; re-upgrade would see stale SQLite unless rollback imports/reconciles the JSON delta. This is a known state-compatibility blocker: either implement and test a reverse handoff/import on rollback, or explicitly accept a one-time cooldown reset and obtain operator approval. Never say cooldown continuity is preserved. Do not restore a stale DB/client-state backup over later acknowledged message state.

### Phase 1.3 measurement / AC (all executable)

1. **Atomic cap:** spawn 40 independent Node workers against a temp DB, same realm/settings/window, all decision times in one window; with a healthy ledger, exactly 10 grants, 30 budget denials, 0 SQLITE_BUSY, rows=10, no corruption. Run 100 repetitions; report p50/p95/max latency and failures. If 50 ms yields busy outcomes, the specified degraded path emits wake and marks run degraded; no claim of exactly 10 in that run.
2. **Same sender:** 20 processes race the same fingerprint; healthy-ledger outcome is one grant, all others cooldown-denied. After 300 s logical clock advance, exactly one further grant.
3. **Window/prune:** after 60 s logical advance, expired budget rows no longer count; sender rows older than cooldown pruned; row count and file-size ceiling asserted under maximum configured budget/cooldown.
4. **Failure matrix:** SQLITE_BUSY timeout, malformed/old schema, read-only directory, ENOSPC/commit failure, corrupted DB, symlink. Assert bounded return ≤50 ms acquisition wait (excluding process scheduling), fail-open wake emitted, no partial ledger transaction, one diagnostic per configured throttle window, `degraded=true` in internal result.
5. **Grant/output:** winner reservation occurs once; losing room never reserves; notifier output failure after commit records known gap and retains message row; crash between commit and append reproduces allowed no-hint case and does not consume message; restart reuses cooldown. For wait, policy selection must happen before grant so only selected hint is charged; if emitting the selected hint fails after grant, report the known no-hint gap and retry behavior explicitly.
6. **Mixed config:** same state path with mismatched policy tuple returns a deterministic config refusal/diagnostic before ledger mutation. MCP and CLI with matching tuple pass.

No implementation begins until the implementation story and a bounded SQLite prototype prove this technical choice, its explicit “best-effort cap while degraded” rule, file-size ceiling, future-clock handling, and resource impact under contention; if audit rejects sidecar SQLite, split a short options spike and ask the operator only for a true product/security decision.

## 12. Requirement-audit execution status

An independent Grill/INVEST audit runner reviewed the plan roadmap and returned no structured findings before its context ended; therefore do not claim that runner's PASS. Codex/agy reviews and the independent implementation-seam audit identified concrete gaps; they are recorded above. The requirements in Section 9 remain the explicit audit rubric, and this plan's status remains **NOT READY for sprint tickets**.

Remaining blockers before ledger implementation/release:
1. The four ledger policy branches are closed in `docs/implementation/reviews/wake-ledger-policy-closure.md`. Still required: implementation and measurement of the Worker/SQLite transaction, numeric state/journal ceiling, resource limits, import and timeout behavior, and cross-process healthy/degraded acceptance tests.
2. Phase 1.1 must be a separately sized correctness story: receiver-side trust classification for raw wait pages, authenticated transport provenance, output/cooldown change, per-row notifier preview parity, and actual-output tests.
3. Phase 3.1 must have a typed synchronous Identity admission API plus port-level tests at the three existing fence/ban checkpoints; no static-principal shortcut.
4. Phase 2 wait flow must settle the ready cohort, choose one deterministic candidate, grant/output once, cancel/drain losers, and prove no losing budget charge.
5. Validate the chosen quiesced JSON↔SQLite cutover/rollback/re-upgrade reset on a copy of current state; do not claim cooldown continuity.
6. Obtain a valid 3-model ACP plan review. The Zai and Qwen seats were removed permanently on 2026-11-02 and replaced by one `opencode acp` free-model lane. The blocker is now provider credentials, not routing: every provider behind `opencode` currently refuses at `session/prompt` (expired key, payment required, invalid key, no credits). Implementation remains gated on three valid, family-distinct reports; do not relabel a fallback identity.

Even after these blockers close, split oversized phases into INVEST-sized stories with explicit allowed inputs, outputs/errors, timeout, concurrency, security role, recovery/rollback, and executable AC. Multi-session aliases remain a deliberate future product decision, not assumed by this plan. The current document is a private review roadmap only; it authorizes no implementation or release.
