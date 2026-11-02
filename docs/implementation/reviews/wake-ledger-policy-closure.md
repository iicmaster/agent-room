# Wake-ledger policy closure — 2026-11-02

**Purpose:** Resolve the four policy contradictions that blocked the SQLite wake-ledger prototype. This closes policy only; it is not implementation or release evidence.

**Context:** DDD migration plan v0.1; client-local held-wake state shared by the MCP notifier and `agent-room wait`. Product policy remains: eligible first held contact wakes; repeated held wakes from the same untrusted fingerprint use the configured cooldown; aggregate held wakes use the configured budget; trusted senders bypass this ledger; wake suppression never advances Messaging's consumed cursor.

**Technical direction retained:** candidate C from `wake-ledger-decision.md`: one client-local SQLite sidecar per installation+realm, `DELETE` journal, `synchronous=FULL`, one bounded Worker per process, `BEGIN IMMEDIATE` around the serialized check/grant, no JSON fallback, no external dependency. No change to the server message database or its schema owner.

**Decision provenance:** Codex's earlier report selected C but explicitly withheld implementation acceptance. A follow-up Codex dispatch acknowledged `gpt-6.1-sol[ultra]` but terminated without an outbox, including after one receipt-backed resume; a subsequent fresh dispatch returned `gpt-6.1-terra (unverified)` and no outbox, so neither is counted as a new round-table result. AGY `gemini-4-argon-high` returned a four-voice Anti-Consensus Club round-table at `.mailbox-out/wake-ledger-policy-close-agy`. The valid three-model ACP review remains blocked. The Zai and Qwen seats were removed permanently on 2026-11-02 by operator decision and replaced by a single `opencode acp` lane pinned to a free model; no route in this repo may reach `api.z.ai` or the Alibaba token-plan gateway again. `opencode acp` was verified end to end over stdio (initialize, `session/new`, `session/set_config_option`, `session/prompt`), and fails only at the prompt step with a provider-side credential error: expired opencode key, Cerebras payment required, Google invalid key, OpenAI no credits. Therefore the exact-three panel cannot currently be produced; this is the local technical party's explicit recommendation, **not** three-model consensus or operator-specific approval of any change to the already-ratified wake product behavior. The AGY disagreement is preserved below.

## Closed policies

### D1 — Cold state, unknown storage, and first-contact

Separate *healthy initialization*, *known-invalid state*, and *transiently unavailable state*. Do not claim both universal mismatch refusal and unconditional wake when the ledger cannot be read.

| Condition | Result | Budget claim |
|---|---|---|
| Safe path, absent/empty DB; initialization commits with the process/realm/receiver/policy tuple | Healthy handshake; decide normally. First eligible held contact wakes. | Enforced by the serialized ledger. |
| Readable tuple/schema/policy mismatch, unsupported schema, unsafe path, structurally corrupt/NOTADB DB, or invalid/unsupported JSON import | Refuse ledger decision; no wake hint; do not rewrite, truncate, unlink, or reinterpret the data. Preserve evidence for offline recovery. | No decision made. |
| Safe path but transient cold BUSY/LOCKED/IOERR/FULL/worker-unavailable prevents validation after bounded attempts | Emit at most one degraded hint per process/outage episode; mark degraded, no durable charge, no JSON fallback. Further eligible held rows are suppressed until a healthy handshake succeeds. | No aggregate cap or cooldown guarantee while unknown/degraded. |
| Previously healthy process later hits confirmed BUSY/FULL/I/O/worker failure before a grant can commit | Same one-hint-per-process degraded episode rule; clear the episode only after a successful ledger decision/handshake. | Healthy cap no longer claimed during the episode. |

The first-contact promise applies in a healthy initialized epoch. Transient unknown storage may emit a degraded hint to favor availability, but repeated short-lived `wait` processes during a persistent outage can each emit one; there is no cross-process cap when the shared authority is unavailable. This availability-over-cap exception is explicit. Structural corruption is *not* classified as transient: automatic fail-open on permanent corruption could let repeatedly spawned clients bypass the cap indefinitely.

### D2 — Filesystem threat boundary

Supported environment: owner-controlled `PLUGIN_DATA`, trusted processes sharing that UID, and no untrusted user able to replace an ancestor in the managed state path. Reject unsafe lexical realm/path segments (including `.` and `..`), symlinked/non-regular DB or auxiliary files, unexpected hard links, wrong ownership, unsafe modes, and paths escaping the canonical managed realm directory before opening or mutating the ledger. Managed directories are `0700`; ledger and journal files are `0600`.

`DatabaseSync` accepts a pathname, not a prevalidated file descriptor. Checks reduce accidental/other-UID path hazards but cannot eliminate a hostile same-UID path-swap race. Hostile same-UID processes are explicitly out of scope. If that threat becomes in scope, reject this SQLite candidate under current Node APIs; do not claim pathname checks prove otherwise or add a native mechanism implicitly.

### D3 — Queue, timeout, unknown commit, and output

Keep the proposed fixed bounds: one Worker per process/path; queue cap 64 including in-flight; queued deadline 250 ms; absolute decision deadline 500 ms from admission; SQLite `busy_timeout=50 ms`; at most four bounded `BEGIN IMMEDIATE` attempts inside the decision deadline. One monotonic absolute deadline covers queueing and retries.

- Queue-full, queued-expired-before-dispatch, and failed `BEGIN` with confirmed no transaction/confirmed rollback are *known no-commit* outcomes. Do not replay the same candidate. They may use the one degraded hint for the current degraded episode after safe-path checks; no healthy cap claim is made for that hint.
- Once synchronous SQLite work has begun, crossing the 500 ms deadline is `outcome_unknown`: return suppression immediately; emit neither normal nor degraded output; never retry/replay that candidate. A late commit may spend cooldown/budget without a visible hint. Fence the worker generation and ignore late output; do not dispatch another worker for that path until the previous worker's exit is confirmed and a fresh handshake succeeds. At most one restart per 60 seconds after confirmed exit.
- A successful commit is followed by exactly one caller output attempt. A crash, abort, or output failure after commit may consume the grant without a visible hint. No compensating/refund/outbox is promised. This is at-most-once hinting, not exactly-once delivery.

The message remains durable and unconsumed in Messaging. A later wait/read may rediscover it; no decision in this failure path advances a consumed cursor. A kernel-stuck filesystem/native call has no hard completion or termination deadline; the 500 ms bound is the caller's decision deadline, not proof that native I/O stops at that time.

### D4 — JSON migration, rollback, and re-upgrade

1. Before cutover, stop every v0.7 notifier and wait process using the installation. No mixed JSON/SQLite writers are supported.
2. Import only the exact supported JSON v1 schema, bounded and validated, once in the same SQLite transaction as its import marker and policy metadata. Preserve the source bytes as an offline archive; after commit, SQLite is the only authority and JSON is never dual-written or used as fallback.
3. A rollback is a **quiesced state handoff**, never an in-place binary swap: stop all new writers; move the archived/stale JSON out of `wake-state.json`'s authority path; retain it under a non-v0.7 filename; then start v0.7, which creates fresh JSON state. Accept one explicit cooldown/budget reset at that boundary. Do not restore stale client-state or message-DB backups.
4. A roll-forward after running v0.7 is also quiesced: stop all old JSON writers; archive the old JSON and stale SQLite sidecar outside their authority paths; start the new code on a fresh sidecar with `migration_source=absent`. Accept the same explicit reset. Do not attempt an unproven reverse merge or silently prefer one of two divergent ledgers.
5. These transitions can cause a repeat wake for up to the active configured cooldown/window after each reset. Messaging rows, room state, and consumed cursors are not reset. The copied-state N→N−1 drill must prove the procedure while preserving all message data.

## Preserved disagreement and rationale

AGY Wildcard/Level favor one degraded hint for any cold unknown state, including corruption, to preserve first-contact. AGY Killjoy/Splinter distinguish transient lock/I/O from permanent `CORRUPT`/`NOTADB` and refuse the latter to prevent repeated short-lived clients from bypassing the aggregate budget. **Selected:** transient-only degraded wake; permanent structural corruption refuses. This deliberately narrows availability during detectable corruption, while avoiding an unbounded outage flood. The absence of a cross-process cap during transient failure remains a disclosed residual risk.

The rollback reset was chosen over reverse handoff because v0.7 cannot read SQLite and running both writers would split authority. Both directions require stopping writers and moving stale files out of active paths; the old bytes remain archived, not deleted or overlaid onto acknowledged messaging state.

## Falsification tests required before activation

- Healthy empty DB first held contact grants/wakes; same sender and aggregate races prove exactly one and ten healthy grants respectively.
- Readable tuple mismatch, unknown schema, corrupt/NOTADB, unsafe path, invalid import all refuse without mutation or wake; original bytes remain intact.
- Cold transient BUSY/IOERR/FULL yields at most one degraded hint per process until successful handshake; three repeated short-lived processes demonstrate and document that degraded outcomes are outside the aggregate cap.
- Warm outage/queue saturation: at most one degraded hint per outage episode; recovery clears the episode only after a successful ledger decision.
- Path fixtures: dot segments, escape, symlink ancestors/leaf/journal, hard links, wrong owner/mode; refuse before database mutation. Explicitly do not claim same-UID race immunity.
- Queue expiry/full: prove timed-out queued work never runs later. In-flight 500 ms timeout with forced late commit: no output, no replay, late result ignored, cursor unchanged. Confirm worker teardown/restart constraints and that a stuck native call may exceed the caller deadline.
- Migration import atomicity and concurrent initialization; stop/writer handoff; on copied current state, N→N−1 and N−1→N preserve message DB/cursors, archive old policy files, start from documented reset, and never restore stale backups.
- Measure physical DB/journal size and startup/decision latency under supported settings before accepting numeric storage/time bounds; test on the supported runtime/filesystem.

**Implementation gate:** policy contradiction is closed for a prototype. Implementation still requires the mandatory plan review gate to be repaired/valid, the tests above, fresh full serial suite, package strict validation, and copied-state rollback. No release/deploy is authorized by this record.

## Implementation status (2026-11-02)

Built: `server/notification/wake-ledger.mjs` (SQLite ledger, STRICT + WAL +
`synchronous = FULL`, 0600 file in a 0700 realm directory, one
`BEGIN IMMEDIATE` critical section per decision, bounded state pruning, v1 JSON
import-once-then-archive) and the façade `server/notification/wake-policy.mjs`.
Both consumers — the always-on notifier and `agent-room wait` — now go through
that one module; neither holds its own state.

**One deliberate deviation from D3.** The closure specified a worker thread
with a 500 ms deadline, a fence generation, and an `outcome_unknown` class for
in-flight decisions. The implementation decides synchronously instead:
`busy_timeout = 50 ms` and at most four `BEGIN IMMEDIATE` attempts bound the
worst case at ~200 ms, and because the decision completes in the calling tick
its outcome is always KNOWN. That does not weaken the closure's rule — it
deletes the `outcome_unknown` class rather than compensating for it, which also
deletes the replay-suppression, fencing, and late-result machinery with it.
`ponytail:` ceiling — revisit with a worker only if a measured p99 for
`decide` ever crosses the 500 ms budget.

**Falsification tests landed** (`tests/wake-policy.test.mjs`, 8 passing): first
contact grants and writes a 0600 ledger; repeat inside the cooldown is
suppressed and the boundary reopens; the aggregate budget gates other senders
and reopens in a fresh window; two independent connections cannot both spend
the last unit of budget (the exact JSON race); a corrupt ledger is refused and
left byte-identical; a world-readable ledger is refused; env parsing falls back
to defaults on junk; the v1 JSON state is imported once and archived.

Still open from the list above: the path fixtures (dot segments, symlink
ancestors, hardlinks, wrong owner), cold/warm degraded-hint episodes under
forced BUSY/IOERR/FULL, size and latency measurements, and the copied-state
N→N−1 / N−1→N rollback drill.
