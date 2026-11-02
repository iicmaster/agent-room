# DDD migration execution status — 2026-11-02, active worktree

This ledger maps the DDD objective to real source/test evidence. It is not completion evidence. Worktree is not yet released; package remains v0.7.0. Wake-ledger implementation, some Identity/Messaging ownership seams, implementation/phase external review, and rollback evidence remain incomplete.

## Verified on 2026-11-02

- `node --test --test-timeout=600000 --test-concurrency=1`: **695 passed, 0 failed**, duration 766019 ms; includes REL-3 compressed validation PASS. Node v24.22.1 / SQLite 3.54.1 were recorded by the soak fixture.
- `node scripts/package-release.mjs --out <fresh absolute directory>` plus `claude plugin validate <fresh>/agent-room-claude-code --strict`: **passed**. Validator emitted only a non-blocking missing-icon warning.
- `git diff --check`: passed.
- Mandatory ACP plan review: **blocked**, not approved. Initial packet had an ambiguous primary family. Corrected OpenAI-family packet got an AGY accepted report. The Zai and Qwen review seats were **removed permanently on 2026-11-02** by operator decision and replaced with a single `opencode acp` lane pinned to a free model; nothing in this repo or in the party-mode profile table may route to `api.z.ai` or the Alibaba token-plan gateway again. `opencode acp` itself was verified end to end on 2026-11-02 (initialize, `session/new`, `session/set_config_option`, `session/prompt` all answered over stdio), but **every provider credential behind it is dead**: the `opencode` provider key is expired, Cerebras answers `Payment required`, Google answers `API key not valid`, and OpenAI answers `no credits remaining`. No exact-three report exists; implementation remains gated on credentials, not on routing.
- No release, publish, deploy, or ledger implementation occurred.

## External audit findings still open

- Identity admission ownership is incomplete: pipeline owns synchronous pin/fence/unpin; long-poll ban/fence checks and send attribution read registries directly; challenge/enrollment and ticket store remain in API. Existing behavior tests pass, but plan ownership target is unmet.
- Messaging is partial: send-only rate admission is still in API `BudgetStage`; store facade owns room lookup/direct membership/page projection helpers; bootstrap/viewer use combined facade. Keep one schema/connection owner; move only with a bounded story and preserved admission ordering.
- `tests/ddd-boundaries.test.mjs` negative fixture is vacuous because `forbidden.mjs` is not present in scanned files. Repair test quality before claiming the ratchet proves rejection.
- Wait first-candidate cohort behavior needs reconciliation against the decision contract; the targeted race test proves the covered losing held room does not spend its grant, not all ordering/fault cases.
- Wake-ledger policy conflicts are now recorded in `docs/implementation/reviews/wake-ledger-policy-closure.md`: transient-only degraded cold wake; hostile same-UID path race out of scope; suppress/no-replay after in-flight unknown timeout; quiesced JSON↔SQLite handoff with explicit cooldown/budget reset. This is policy closure only; the executable prototype ACs, same-UID threat boundary checks, reset/re-upgrade drill, and valid 3-model plan review remain open.
- Because this turns out not to fit remaining implementation gates safely in this pass, no broad store split or ledger caller integration was started.

## Current execution status

Identity binding and Messaging read/send application extractions are behaviorally verified at focused gates and in the 695-test full suite. The migration is still **incomplete**: no cross-process ledger, no complete Identity admission port, no full Messaging ownership split, no copied-current-state rollback demonstration, no valid three-model plan/completion reviews.


## Completed slices in current worktree

### Notification ownership (Phase 2 — extraction in progress)

- New owner modules: `server/notification/notifier.mjs`, `wake-policy.mjs`, `delivery.mjs`.
- `server/mcp-stdio.mjs` imports notifier directly; `server/cli/wait-commands.mjs` imports the Notification wake-policy and DeliveryClassifier port; `server/client/notifier.mjs` and `server/client/wake-policy.mjs` are compatibility re-exports.
- `tests/ddd-boundaries.test.mjs` ratchets Identity/Notification/ Messaging direction; the only Notification→client edges are explicitly allowlisted (`api-client.mjs`, `trust.mjs`).
- Delivery port parity tests verify existing trust matrix for local, remote, allowlist, accept-all, own sender, held marker/no body.
- Still transitional: `server/notification/delivery.mjs` delegates to `server/client/trust.mjs`; notifier adapts current ApiClient/lifecycle. Remove these only when provider/context APIs exist and caller tests remain green.

### Wait trust correction (Phase 1.1 — fixed)

- `server/cli/session-commands.mjs:authenticate()` returns earned transport (`local` only after local-token exchange, `remote` after challenge answer); declared remote mode uses challenge auth even on loopback.
- `server/cli/wait-commands.mjs` classifies raw HTTP rows through Notification DeliveryClassifier before held cooldown. It does not trust a nonexistent server-side `held` flag; allowlist is re-read per row.
- Regression cases: Local delivery; configured HTTPS remote using the shared test CA with normal TLS verification; declared-remote loopback challenge auth; held first-contact metadata hint; same-sender repeat cooldown; allowlist fingerprint; body absent from wait hint; existing own-send suppression and overflow test.
- Suppressed held sender is tracked only in this wait invocation (no durable consumed cursor advance); the next wait re-evaluates persisted cooldown/allowlist. This prevents a hot poll loop and preserves the wake/log distinction.

### Identity ownership (partial extraction)

- `server/identity/session-binding.mjs` now owns synchronous bind/rename/takeover orchestration. `server/api/server.mjs` retains wire-shape validation, API error-envelope mapping, timestamps and route registration; ticket burn/recheck and durable-persist-before-memory-transfer ordering remain intact.
- Latest Identity regression run: **165/165** across session routes/replacement, presence, challenge/local auth and store. This verifies behavior, not completion of the Identity admission capability.

### Messaging ownership (partial extraction)

- Focused Messaging regression run: **64/64** across direct-room service/API, rate/idempotency and store. Same SQLite schema/connection owner remains `server/store/room-log.mjs`.
- Audit found remaining seams: send-only budget ownership is in API `BudgetStage`; the store facade still supplies room lookup/direct-membership/read projection helpers; API bootstrap/viewer use the combined facade. Do not move schema/bootstrap or change admission order as cosmetic cleanup.
- `tests/ddd-boundaries.test.mjs` has a vacuous negative fixture: its named `forbidden.mjs` does not exist under the scanned context tree. Replace with an actual temporary/in-memory forbidden import fixture before claiming the ratchet proves rejection.

### Latest focused gates

- Notification/wait/wake-policy/boundary suite after pure-probe/abort refactor: **28/28**.
- Identity/session/auth/presence/store after `bindIdentitySession` wiring: **165/165**.
- Messaging/direct-open/store/rate/idempotency/boundary: **64/64**.
- Fresh package materialization + `claude plugin validate <fresh>/agent-room-claude-code --strict`: **passed**; validator emitted non-blocking missing-icon warning.
- Mandatory ACP plan review: initial packet had ambiguous primary; corrected OpenAI-primary packet got AGY. Zai and Qwen were removed permanently on 2026-11-02 and replaced by one `opencode acp` free-model lane whose credentials are currently dead. No valid 3-model plan review; no ledger implementation started.
- Full serial run with documented `--test-timeout=600000` is still running; first default-timeout run was stopped because the suite's documented REL-3 soak exceeds the default timeout. No full-suite verdict yet.

### Identity admission gap (audit)

- Identity still does not own a synchronous public admission capability: pipeline owns pin/authz/post-input fence/finally-unpin; long-poll handler and send attribution read live registry directly; challenge/enrollment orchestration and conflict-ticket store remain in API. Existing fence behavior tests pass, but ownership goal is not met.
- `session-binding` is behaviorally covered via route tests; direct port tests for burned rightful ticket after persistence failure and same-key admission concurrency remain absent.

### Notification cross-process ledger (blocking)

- Existing JSON ledger remains TOCTOU. No implementation started because the required three-model plan review is blocked by local ACP executable trust-root configuration; AGY alone completed. Codex recommendation and prior AGY 429 are not new consensus.
- The closure record resolves cold unknown vs mismatch/corruption, accepted pathname threat boundary, timeout/late-commit output, and JSON rollback/reset. Remaining implementation clarifications include sharing one policy path per installation+realm, proving numeric env bounds/storage ceilings, and wiring outcomes into both callers.
- ACP lane diagnosis: the Zai and Qwen lanes are deleted, so their failure modes are historical and no longer reachable. The replacement `opencode acp` lane completes the ACP handshake and model selection, and fails only at `session/prompt` with a provider-side credential error per provider (expired opencode key, Cerebras payment required, Google invalid key, OpenAI no credits). Do not route around this by renaming an alias or substituting an unapproved family. AGY passed; exact-three gate remains blocked on credentials; no implementation started.
- Wait selection chooses the first response cohort and aborts others, while the recorded decision's deterministic selection details need reconciliation; recent local regression passes establish loser grant behavior only for covered cases.

### Identity ownership (partial extraction)


- `server/identity/claims.mjs`: claims, recency, pruning, enrollment operations.
- `server/identity/repository.mjs`: composes claims/enrollment, bans and invites over injected same DB/transaction runner.
- `server/identity/sessions.mjs`: token sessions, verifier, supersession fence and in-flight pin lifecycle; `server/api/session.mjs` compatibility re-export; server/viewer import Identity directly.
- `server/store/room-log.mjs` remains the one DB/schema/migration/connection owner and delegates Identity operations.
- Still not extracted: `bindSession`/observe-ticket-transfer orchestration, conflict-ticket ownership, API-to-domain result adapter. The 3 synchronous fence/pin checkpoints remain in pipeline/server at their existing locations.

### Messaging ownership (partial extraction)

- `server/messaging/direct-room.mjs`: direct-room resolution app service; accepts claim lookup + `openDirectRoom` ports; API handler owns input validation/wire errors.
- `server/messaging/rooms.mjs`: broadcast/direct create/ensure, membership projection, page reads, head sequence and room lookup through injected same DB/helpers.
- `server/messaging/messages.mjs`: idempotency probe + append transaction (duplicate/reply/storage/seq/warn ordering) through injected same DB, transaction, ACL and warning callbacks.
- `server/store/room-log.mjs` delegates these public operations; no schema/API/DB connection change.
- Still not extracted: realm bootstrap/application composition and many DB façade methods; composition root/schema owner deliberately remains in store.

### Current gates passed

- Identity/store/fence/auth/presence/direct/invite/ban gates: **206/206**.
- Messaging/store/rate/storage/API/MCP/viewer gates: **105/105**; direct-room app service: 4/4.
- Notification/wait/wake-policy/boundary/remote-client combined focused run: **243/243**.
- Notification+wait real child integration and wait suite rerun after latest wiring: **27/27** earlier; included in the combined 243 run.
- Package tests explicitly require all new context modules in both package forms. Fresh materialize + strict validator was run before the latest module moves, and passed for source tree state then; must rerun on final tree.

## Outstanding blockers (goal remains incomplete)

1. **Wake ledger cross-process correctness:** `server/notification/wake-policy.mjs` still JSON read/decide/atomic rename; TOCTOU remains. Codex chose one prototype candidate C (client-local SQLite DELETE/FULL in one bounded Worker), but AGY was quota-refused (429), so no two-vendor ratification. Decision record: `docs/implementation/reviews/wake-ledger-decision.md`. No ledger implementation yet; do not claim aggregate cap under concurrent/degraded writes.
2. **Wait completion semantics:** per-process suppressed sender behavior is bounded/no-consume; still need tests for a suppressed held row followed by trusted eligible row in same multi-room cycle, allowlist change during an active wait, concurrent rooms/lost attempts, wait loser abort/drain, timeout and lock cleanup.
3. **Identity completion:** extract bind/ticket orchestration into Identity application operation; preserve observed-holder ticket burn/foreign collision confidentiality/durable persist-before-memory transfer; keep the exact pin→authz→post-input fence-only→per-poll ban+fence→finally-unpin order. No boundary move may weaken it.
4. **Messaging completion:** move remaining app/store ownership incrementally; inventory all API/CLI/viewer/bootstrap consumers; preserve realm/schema migration root and existing operation order. No second DB or schema owner.
5. **Rollback/state:** the proposed SQLite wake ledger migration from JSON has no implementation or reverse handoff yet. v0.7 old writers cannot coexist with new SQLite writers; need proven maintenance stop and operator-accepted rollback cooldown behavior before enabling it.
6. **Release quality:** run final `node --test --test-concurrency=1` after all edits; materialize fresh packages; strict validator; package content/context assertions; N→N−1 copied-current-data rollback; then new digest/freeze/release/deploy only if all phase gates pass. REL-3 stays notifier-off until recalibration.

## Completion rule

Not complete until all planned Identity/Messaging/Notification ownership seams and ledger gate are implemented or explicitly rejected with a ratified alternative, all current+new ACs are covered, full serial suite and packaged artifacts pass, compatibility rollback is demonstrated, and a checklist maps every DDD plan phase to concrete source and evidence. Directory existence, focused green tests, or this status page do not complete the objective.
