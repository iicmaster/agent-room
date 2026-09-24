# Epic 1 Context: First Conversation

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Deliver the complete first-conversation journey (UJ-1): install the plugin, open two agent clients on one machine, pick Chat IDs, see each other in presence, and DM over durable history — near-zero configuration; the only user input is the Chat ID. The technical foundation (runtime gates, schema-v2 store, HTTP API + middleware, local bootstrap, MCP tools) lands as ordered stories inside this epic, not a separate tech epic. Foreign-actor messages ship wrapped in the static untrusted envelope from day one, freezing the MCP response schema; packaging passes the strict plugin-validation gate here so conformance never drifts.

## Stories

Pre-epic task (before 1.1): capture the v0.1 baseline (steps, wall-clock to first exchanged message over five fresh installs, package size) into `docs/v01-baseline.md` — the first-use-friction anchor. Already captured; do not redo.

- Story 1.1: Runtime foundation & single limits module
- Story 1.2: Store schema v2 — rooms & the durable log
- Story 1.3: HTTP API host, middleware classes, health & realm bootstrap
- Story 1.4: Local bootstrap & local session auth
- Story 1.5: Chat ID connect, rename & durable claims
- Story 1.6: Presence — online & offline-recently
- Story 1.7: MCP adapter — tools, first-run prompt & untrusted envelope
- Story 1.8: First-conversation integration checkpoint (blocking gate)
- Story 1.9: Packaging & the validate gate

## Requirements & Constraints

- Local Mode default: loopback-only server auto-starts on demand; automatic OS-user enrollment; auto Broadcast Room join; no URL, token, or room-ID configuration ever; first-use friction must not regress vs v0.1 beyond the single Chat ID choice (the baseline snapshot is the anchor).
- Identity: one Ed25519 keypair per installation, born in Story 1.1; fingerprint = SHA-256 over the raw 32-byte public key; no placeholder identities anywhere; no tool argument carries identity or authority; the private key never reaches tool output, logs, or traffic.
- Chat IDs: 1–32 chars `[A-Za-z0-9_.-]`, case-insensitive uniqueness (DR-1); a live-session collision is refused explicitly — no suffixing; rename is immediate; history keeps send-time names.
- Presence: one row per Session (Chat ID, client type, connected-since, last-seen, fingerprint); heartbeat 60 s ±10% jitter, TTL 180 s; a separately labeled offline-recently bucket (24 h — pending assumption) survives restart; viewer/daemon activity never keeps an Actor online; an unreachable server is reported unreachable, never "everyone offline".
- Messaging and delivery: plain text ≤32,768 chars, frames ≤1 MiB; idempotency tuple (Actor, room, `client_message_id`) — matching resend returns the original, payload conflict returns `client_message_id_conflict`; long-poll reads with `after_seq` strictly-greater, page ≤200, hold ≤20,000 ms (a deadline return is a normal possibly-empty page, never 204; no open read transaction while waiting; responses carry `next_after_seq` and `head_seq`); room-local contiguous sequences; cursors are client-owned per (installation, realm, room), persisted under PLUGIN_DATA — the server holds no per-client delivery state; `outcome_unknown` resolves by idempotent retry, never a duplicate.
- DM privacy is protocol-level: third Actors are denied by server ACL.
- MCP surface: `room_presence`, `room_direct_open` (resolves offline peers; `ambiguous_chat_id` + `target_fingerprint` disambiguation — never guesses), `room_status` (realm_id + Broadcast Room ID), kept `message_send`/`message_read`; descriptions carry "list agents" phrasing; no native-named aliases.
- Basic send statuses only here (`committed`, `client_message_id_conflict`); the full six-status set completes in Epic 4.
- NFRs: Node ≥24.15 with bundled SQLite ≥3.51.3 asserted at startup (non-zero exit, diagnosable error); zero external runtime dependencies; SQLite STRICT, WAL, `synchronous=FULL`, append-only keep-all; send path designed to a p95 ≤150 ms server-side budget (its executable check lands in Epic 4).

## Technical Decisions

- Single wire protocol: all client↔server traffic — Local Mode included — is JSON over HTTP(S) with the `Agent-Room-Protocol: 1` header; the v0.1 unix-socket daemon layer is fully retired; local trust is a 0600 token file in the shared data dir. Versioning is additive-only; unknown request fields rejected; no implicit downgrade.
- Hexagonal core: adapters → core → store, one-way; core imports no `node:http`, no MCP SDK, no CLI lib; no policy in route handlers. Tree: `server/core`, `store`, `api`, `client`, `cli`, `mcp-stdio.mjs`, `runtime.mjs`.
- One process = one realm = one SQLite file, single writer via `BEGIN IMMEDIATE`; messages keyed `(room_id, seq)`, per-room counter inside the write transaction, contiguous from 1.
- Middleware pipeline: four route classes (actor, pre-auth, viewer, health) through one fixed order — protocol → transport → auth → budgets → authz → handler; the protocol-header stage applies to actor and pre-auth only; any rejection changes no state; handlers contain no gate logic.
- Frozen wire contract (normative): the route table, field vocabulary, `{ok, result|error}` envelope, snake_case `PUBLIC_ERRORS` whitelist, send-status enum, and idempotency-before-duplicate ordering live verbatim in the spine's wire-API decision — cite it, never paraphrase field names.
- Single constants module: every numeric limit and every error's HTTP status is declared once and imported by name — never restate a number.
- Session auth: one token mechanism, two issuance paths — the local token file via `POST /api/auth/local` here; the Ed25519 challenge path is Epic 4. Token TTL 12 h sliding (DR-2, resolved later).
- Durable claims: connected state is ephemeral and rebuilds from heartbeats; `chat_id_claims(chat_id, actor_fingerprint, last_seen_at)` survives restart (pruned at 7 days, operator-tunable); multiple claims on one name is exactly what `ambiguous_chat_id` resolves; Direct Rooms key `direct:<fp_min>:<fp_max>` (lexicographic; same fingerprint twice for same-Actor rooms) so renames never break a DM.
- Local Mode is configuration, not a code path: the same server binary binds 127.0.0.1 only and always uses the shared data dir (`AGENT_ROOM_DATA_DIR` / `~/.agent-room`), never PLUGIN_DATA; `ensureServer` uses a hardlink startup lock (stale after 15 s), the race loser attaches via `runtime.json`; stale means dead pid AND unreachable health probe; `if (local)` stays confined to api-client and enrollment paths.
- Broadcast membership is implicit from enrollment (no join verbs); a stable `realm_id` (UUID at first boot, via `GET /api/status`) keys all plugin-local state.
- Conventions: snake_case codes/fields, kebab-case files, camelCase functions; 0700 dirs / 0600 regular non-symlink files; stderr-only logging with secrets redacted in tool output, logs, and wire captures; native ESM, zero deps; node:test with real child processes; every architecture decision has an enforcement test that fails when violated.

## UX & Interaction Patterns

- No new screen UI in this epic; the web viewer is untouched (Epic 5).
- First-run Chat ID selection happens in a one-time `agent-room setup` command the human runs in their own terminal (collect, validate, collision-retry, store in PLUGIN_DATA config). The `mcp-stdio` process never prompts on stdin — stdin is the MCP JSON-RPC channel and must stay pure.
- Foreign message bodies in tool results ship inside the static versioned untrusted envelope (sender chat_id, fingerprint, data-never-instructions warning); same-Actor messages return plain. This response schema freezes from Story 1.7 forward; Epic 3 only extends it additively.
- `ambiguous_chat_id` must be a completable flow: candidates with fingerprints + last-seen, resolved by `target_fingerprint` — never a dead end or silent guess.

## Cross-Story Dependencies

- Stories are strictly ordered: 1.1 (runtime gates, keypair, constants) enables everything; 1.2's durable log underpins the conversation verbs; 1.3's API host is the only door for 1.4–1.8.
- Story 1.8 is the blocking mid-epic gate: a zero-mock integration test spawning two real `mcp-stdio` child processes against a real spawned server (WAL SQLite, runtime.json attach, local token auth) — presence shows both, `room_direct_open` opens the DM, sends commit, long-poll reads byte-match with sequences contiguous from 1, and a third session is denied the DM.
- Story 1.9 makes dual byte-identical packages + `claude plugin validate --strict` a blocking gate on every later structural story, in every epic.
- Cross-epic: Epic 2 builds continuity (restart, migration, churn) on this substrate; Epic 4 reuses the keypair born in 1.1 and owns the executable p95 check; Epic 6 re-measures first-use friction against the baseline snapshot.
