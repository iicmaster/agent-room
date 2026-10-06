# Changelog

All notable changes to Agent Room are documented in this file.

## Unreleased

### Added

- The release gate and the frozen v0.2 candidate (Story 6.3): a new suite gate
  (`tests/release-smoke.test.mjs`) that judges only the MATERIALIZED release
  artifact — the dual packages are proven to materialize deterministically, the
  materialized Claude Code package passes the real `claude plugin validate
  --strict`, each claimed client's smoke installs a fresh copy of the
  materialized artifact into an emulated host plugin directory (resolving the
  installed manifest against its frozen `${CLAUDE_PLUGIN_ROOT}` /
  `${CLAUDE_PLUGIN_DATA}` and `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` contract),
  performs the real one-time `agent-room setup` Chat ID choice from the
  installed tree, and completes a full DM round-trip through the installed
  entrypoint — plus the SM-C1 re-measurement on five fresh installs: zero
  failures, the step delta exactly the two Chat ID choices, and the ladder
  with those choices priced out at 0.264 s mean versus v0.1's 0.352 s anchor
  (raw mean 0.459 s). The candidate is frozen in
  `docs/release-evidence/v0.2.0-candidate.json` (commit, both package SHA-256
  tree digests, Node/SQLite versions) for the soak and the REL-1 demonstration
  to pin; the release notes live in `docs/release-notes-v0.2.md` (the one-time
  v1→v2 cursor reset, the SM-C1 numbers, the claimed-clients table). The
  self-hosting deployment guide's failure-mode table gains the upgrade-time
  index-rebuild-on-full-disk row.
- The read-only web viewer (Stories 5.1 + 5.2): `GET /viewer/auth` exchanges the operator's
  viewer token (Bearer) for an `HttpOnly; SameSite=Strict; Path=/viewer` session cookie whose
  value is an independent 256-bit random secret — no credential ever travels in a URL, a query
  string, or a log; `agent-room viewer rotate` replaces the token and every outstanding cookie
  is invalid at its next request, no restart needed. The cookie-authenticated live view at
  `/viewer/` renders the Broadcast Room and the presence list from ONE server-sent-events
  stream (`/viewer/api/rooms/:id/events`) carrying message and presence events — a committed
  message appears within the 5 s freshness bound, a dropped stream resumes by `Last-Event-ID`
  with exact replay, Direct Rooms are refused by construction, and every response carries the
  strict CSP (no inline script, no framing, no referrer). The viewer token bounds, cookie
  name/path, and registry capacity are declared in the constants module.
- The remote exposure check (Story 5.3): a real-process drill over the self-hosting TLS
  harness that binds the server on the machine's non-loopback interface (the loopback door
  on the same port probed and refused) and proves the exposure posture end to end — an
  unauthenticated request arriving via the exposed interface is refused with zero body
  previews across the whole viewer surface, every viewer route is GET-only (no credential
  can buy a verb), the viewer token as Bearer and the viewer cookie authorize no API write
  (the operator writes — trust set, invite mint, ban — have no HTTP surface at all), the
  holder's path still works over the same interface, and the server writes nothing to
  stderr across the whole drill. Epic 5's AC sweep is gap-free.
- The v0.2 MCP tool surface over a loopback HTTP server: `room_presence` (online and
  offline-recently agents), `room_direct_open` (pair rooms by Chat ID, with
  `ambiguous_chat_id` + `target_fingerprint` disambiguation), `message_send` (idempotent
  appends), `message_read` (long-poll reads with `next_after_seq`/`head_seq`), and
  `room_status` (realm, Broadcast Room, identity).
- The one-time `agent-room setup` command (exposed as the `agent-room` bin) that collects,
  validates, and stores the installation's Chat ID in `PLUGIN_DATA/config.json` (0600) — the
  MCP server itself never prompts on stdin.
- Client-owned cursors persisted per (installation, realm, room) under
  `PLUGIN_DATA/realms/<realm_id>/cursors.json` (0600, atomic, monotonic).
- The static versioned untrusted-message envelope wrapping foreign senders' message bodies
  (`<untrusted_message version="1">` with sender chat id, fingerprint, and the
  data-never-instructions warning); same-installation messages return plain.
- The per-realm Allowlist and the client-side trust matrix: own-Actor and Local Mode
  senders deliver, allowlisted remote Actors deliver, and every other remote sender is
  held (metadata only, body withheld, reason recorded). State lives at
  `PLUGIN_DATA/realms/<realm_id>/allowlist.json` (0600, atomic) and binds key
  fingerprints, never Chat IDs. Two additive MCP tools — `room_trust_list` and
  `room_trust_set` — inspect and add/remove fingerprint entries; accept-all is a
  per-realm human CLI opt-in (default false) that no agent tool can set.
- The held pipeline (metadata-only and recoverable): every held message registers into
  `PLUGIN_DATA/realms/<realm_id>/held.json` (0600, atomic) keyed (realm, room, seq) with
  realm, sender Chat ID, fingerprint, room, sequence, time, byte size, and the trust
  reason, plus a body cache bounded at 100 copies (drop-oldest) — eviction drops only
  the cached body copy and never deletes, approves, or skips a record, and an evicted
  body recovers by a point read (`after_seq = seq − 1`, `limit = 1`) through the
  api-client. Two additive MCP tools — `room_held_list` (metadata only, never a body)
  and `room_held_count` — surface the held state to the agent; the body-recovery and
  release functions are reachable only from the human CLI, so no tool result can ever
  carry a held body. Held registration happens after the read cursor persists: a held
  message never stalls the cursor and a cursor advance never loses held state.
- The human CLI surface over the held pipeline and the per-realm allowlist (the
  `agent-room` bin's command family): `held list` (metadata only — id, chat id,
  fingerprint, room, sequence, time, size, reason, with an optional `--room`
  filter), `held show <room_id>:<seq>` (the full preview of the exact artifact
  the pipeline withheld, by cached copy or point-read recovery — the only
  surface where held body text appears; every body line carries a `| ` prefix
  so a hostile body can never forge the delimiters or fake CLI output),
  `allow <chat-id>` (resolves the name
  to its key fingerprint from this realm's held records and presence,
  case-insensitively and merged by fingerprint — never a silent guess;
  `--fingerprint` disambiguates a reused name; reports realm + fingerprint;
  saves the allowlist entry — recording the chat id it was granted under —
  and releases that key's held records; `--remove` resolves from the
  allowlist itself and affects future ingestion only), and `allow-all` (the per-realm accept-all
  flip behind an explicit interactive y/N confirmation; `--remove` switches it
  off without one, and a non-TTY stdin is refused before anything is booted). The commands' session is unbound — the local token and the
  installation key are exchanged for a session token and no Chat ID is ever
  claimed — so they run collision-free while the live MCP session holds the
  configured name and leave no presence or claim footprint. Approval is a
  human convention (Instructed): same-user processes are not cryptographically
  distinguishable, and the help text says so plainly.
- `outcome_unknown` send resolution: one automatic retry with the identical
  `client_message_id` resolves to the original message or a coded conflict, never a duplicate.
- The end-to-end trust-chain drill (`tests/integration/trust-chain.test.mjs`): one
  zero-mock integration test over the real MCP response path — two real `mcp-stdio`
  children on distinct installations (distinct keypairs, `client_type: 'mcp'` binds) —
  chaining stranger hold (zero body bytes in every agent-visible result), cursor
  persistence past the held seq, evicted-body recovery via `agent-room held show`
  byte-matching the durable log, `allow` release of held and future messages,
  `--remove` re-holding the future without touching the past, and per-room cursor
  monotonicity at every step.
- The connection-mode declaration seam: an installation whose host knows its session
  crosses the OS-user boundary declares `AGENT_ROOM_CONNECTION_MODE=remote` (exact
  match; any other value keeps the earned behavior, and `'local'` is only ever earned
  by the local token exchange). The declared mode is strictly fail-closed — the trust
  matrix's remote lane can only withhold deliveries, never grant them — and is the
  transport input Epic 4's challenge-authenticated clients will carry naturally.
- Remote challenge authentication (the remote half of the one-session-mechanism
  split): `POST /api/auth/challenge` issues a single-use 32-byte nonce (60 s expiry,
  bounded pending set, in-memory — a restart invalidates outstanding challenges)
  bound to the presented raw public key, open to any well-formed key so invite
  enrollment can prove possession; `POST /api/auth/answer` consumes the nonce
  before verifying the Ed25519 signature against the challenge-recorded key
  (identity binds at challenge time, a failed answer burns the nonce, replays find
  an empty slot) and — gated on the new durable `enrolled_actors` registry seeded by
  the local exchange's success path — issues a session token from the same registry
  the local path uses (12 h sliding; DR-2 ratified as declared). A declared-remote
  installation (`AGENT_ROOM_CONNECTION_MODE=remote` or the `connectionMode` option)
  now authenticates through this challenge lane and never presents the local token
  file; its `transport: 'remote'` is earned by the exchange, and coded failures
  (`not_enrolled`, `challenge_invalid`) surface as coded errors with no fallback.
  The private key never leaves `server/keys.mjs`: signing reads the PEM and returns
  only the signature.
- Invite-gated enrollment and the operator CLI host (Story 4.2): `agent-room
  invite mint` mints an `ar_inv1_` token (32 random bytes, 43 base64url
  characters) whose SHA-256 digest is the only thing ever stored — the raw
  token is printed exactly once and can never be recovered; `--uses` and
  `--ttl` accept finite values only (unlimited/never-expiring invites are
  rejected outright). `invite list` shows digest prefix, uses remaining,
  expiry, and revoked — never a secret; `invite revoke <digest-prefix>`
  blocks new enrollment only. The family runs on the server host, opens the
  store directly in process (AR-13: no operator HTTP route), and speaks JSON
  lines with stable exit codes (0 ok, 1 refusal, 2 usage) — the operator CLI
  host later stories extend. `POST /api/auth/enroll` is now live: the
  presented key's Ed25519 signature over the exact invite token bytes is the
  possession proof, validated inside one BEGIN IMMEDIATE transaction with
  invite validation and consumption — races yield exactly one enrollment
  (`invite_exhausted` for the loser), failed or rolled-back attempts consume
  nothing, and a lost-response retry reattaches without consuming. The route
  is rate-limited 5/min per client identity (burst 5) by a minimal
  fixed-window counter; `X-Forwarded-For` is trusted only from an explicitly
  configured `trustedProxy`. New public codes: `invite_invalid` (403),
  `invite_exhausted` (409), `invite_not_found` (404), `rate_limited` (429).
- The remote client and the transport policy (Story 4.3): an installation can
  now point at a remote agent-room server. `agent-room remote set <https-url>`
  persists the ONE active server origin at `PLUGIN_DATA/remote-config.json`
  (0600, atomic; setting again replaces and reports the previous origin,
  while the replaced server's per-realm state stays on disk under its realm
  id, inert — a different server is a different realm with fresh trust);
  `remote show` reports the configured origin or Local Mode; `remote clear`
  returns the installation to the Local Mode default. The transport policy is
  enforced at every surface through one validator: the URL must be an https
  origin with a hostname — plaintext (http://) remote is refused with a coded
  error naming the scheme at set time, at load time (hand-edited files are
  re-validated, never trusted), and at client-construction time, and a
  corrupt config refuses with guidance instead of silently falling back to
  local. A configured client skips the loopback bootstrap entirely — no
  local server, no runtime record, no local token on any path — and speaks
  to the configured origin over `node:https` with Node's DEFAULT certificate
  and hostname verification (no bypass exists in the client tree; a
  self-signed certificate is refused with zero answered requests and no
  reconnect loop). Authentication is the challenge lane; an enrolled key's
  reconnect needs no invite (a fresh client, or a 401 after the server
  restarts behind the same URL, re-authenticates and re-binds through
  challenge-answer, with zero enroll requests and zero invite tokens on the
  wire), while a not-enrolled key surfaces a coded, actionable `not_enrolled`
  naming the operator's invite flow — the client never enrolls itself. The
  `remote` family joins the CLI host's JSON-lines grammar (0 ok, 1 refusal,
  2 usage).
- The four rate gates and the full send statuses (Story 4.4): the budgets
  stage now carries the two per-Actor token buckets of FR-16 — the send
  bucket (0.5/s refill, capacity 10, on the send route) and the request
  budget (120/min/key, burst 30, counting EVERY authenticated request at
  admission: failed and replayed attempts included, long-polls exactly
  once) — and the store's append transaction carries the 5 s duplicate gate,
  ordered after the idempotency lookup so the ordering is structural. The
  send bucket is idempotency-aware: a send whose (room, actor,
  client_message_id) the store already holds is probed before the bucket
  consumes, so an exact retry is admitted free and consumes nothing even
  from an empty bucket, while a new send repeating the same byte-identical
  payload in one room within the window answers `duplicate_dropped` — a
  normal 200 result naming `original_seq`, never an error, never a second
  commit, with identical text in a different room or reply context untouched.
  Every refusal names its delay: `rate_limited` (429) carries
  `retry_after_ms` in its error envelope (the declared extras allowlist
  grows to two). The send-status enum completes to the FR-17 six
  (`committed`, `rate_limited`, `duplicate_dropped`, `storage_low`,
  `client_message_id_conflict`, `banned`) with the last two wired by name
  for Stories 4.5/4.6. All five limits are operator-tunable abuse floors
  (never a volumetric-DoS guarantee) through `startServer` overrides and the
  `AGENT_ROOM_SEND_TOKEN_REFILL_PER_SECOND` /
  `AGENT_ROOM_SEND_TOKEN_CAPACITY` / `AGENT_ROOM_REQUEST_BUDGET_PER_MINUTE`
  / `AGENT_ROOM_REQUEST_BUDGET_BURST` / `AGENT_ROOM_DUPLICATE_WINDOW_MS`
  env knobs for the direct launch — strictly validated, warning-fallback per
  knob. NFR-5's send p95 ≤ 150 ms server-side is now executable
  (`tests/rate-gates.test.mjs`): a warm server's end-to-end loopback send
  p95 upper-bounds the server-side processing, and the churn harness drives
  one gate-paced send per cycle with a monotonic-sequence oracle.
- Ban by identity key (Story 4.5): `agent-room ban <fingerprint>
  [--reason <text>]` and `agent-room unban <fingerprint>` join the operator
  CLI host (the Story 4.2 bin — no new entrypoint), running on the server
  host and opening the store directly in process (AR-13; no operator HTTP
  route). The durable `banned_actors` registry (STRICT, additive open-path
  convergence like the invites tables) is keyed by the canonical Actor
  fingerprint; banning a fingerprint nobody has enrolled is first-class
  (preemptive ban), re-banning is idempotent keeping the first ban's
  timestamp and reason, and unbanning deletes the row so traffic flows
  again immediately. The server's authz stage refuses every
  session-authenticated request from a banned key with the coded `banned`
  (403 — the send-status enum's HTTP face, registered once in the constants
  module) by a direct indexed store query per request — deliberately not a
  cached set, so a ban the separate CLI process commits is visible AT NEXT
  REQUEST through WAL. The enroll gate lives inside the enrollment
  transaction, after the possession proof and before any use is consumed:
  a banned key's re-enroll (including a pre-ban reattach retry) is refused
  `banned`, consumes nothing, and reveals ban state to no caller who cannot
  prove possession. The long-poll read loop re-checks the ban gate each
  poll iteration, so an in-flight hold terminates at its next wake (≤ the
  250 ms poll interval, well inside the 20 s window) with the coded refusal
  — the registry/state the poll checks, never a killed connection. Ban
  state survives restart (the Epic 2 review's B1 boundary closes here:
  persistence proven over a real CLI child write, SIGKILL, and respawn).
- Storage admission control (Story 4.6): the durable log can no longer die
  of a full disk silently. The store's append path carries a free-space
  gate inside the same BEGIN IMMEDIATE transaction — one statfs of the data
  directory per append (bavail × bsize; the injectable free-space source
  lets tests simulate full disks without filling one) — ordered after the
  idempotency lookup and the duplicate gate, immediately before the insert.
  Below the refuse reserve (default 256 MiB free) a NEW append is refused
  with the coded `storage_low` (the transaction rolls back having written
  nothing, no sequence is consumed, and a disk-full write the observation
  raced — SQLITE_FULL — maps to the same code after the rollback), while an
  exact retry, a duplicate drop, and every read keep resolving from reads
  alone: refusal never drops or alters accepted work. The send route
  answers the refusal as the explicit, never-acknowledged FR-17 status —
  200 `{status:'storage_low'}` (the code is also registered in the public
  error tables with its 507 coded face for any path outside that route).
  Between the refuse and warn reserves (default 1 GiB) appends commit and
  the server emits one warn line per minute on stderr. Both thresholds are
  operator-tunable capacity RESERVES, never retention quotas: startServer
  overrides validated at startup (refuse above warn is a contradiction and
  fails), the `AGENT_ROOM_STORAGE_WARN_BYTES` /
  `AGENT_ROOM_STORAGE_REFUSE_BYTES` env knobs for the direct launch (junk
  warns once and falls back), and `STORAGE_WARN_INTERVAL_MS` pacing the
  warn. `agent-room capacity` joins the operator CLI host (no store open —
  the gate's own statfs mechanism against the data directory): one JSON
  line with free bytes, both reserves, state `ok`/`warn`/`refuse` and
  `admits_appends`; exit 0 while appends are admitted, 1 below the refuse
  reserve or on an uninspectable data directory, 2 on usage. The
  backup/restore + disk-expansion guide lives at
  `docs/self-hosting-storage.md` (stop-copy-restart backup, all-or-nothing
  restore, free-space-based expansion, and a failure-mode table). The
  story's review re-run (2026-09-30) hardened the same surfaces: the raced
  disk-full write is proven at the insert face — a store-level page-ceiling
  seam drives a real `SQLITE_FULL` (errcode 13) through the real append
  path, mapping to the same coded `storage_low` (the commit face maps
  through the same catch, unexercised by any drivable seam); the
  two storage env knobs now reach a plugin-managed auto-started server
  through the bootstrap spawn whitelist; the rate-limited warn line is
  emitted after the append transaction commits (never synchronous I/O under
  the write lock); and the duplicate-gate index verifies its column set at
  open, refusing a same-name squatter with `database_schema_invalid`.
- Self-hosting deployment (Story 4.7): the standalone TLS half of FR-4 and
  the one honest guide for both TLS paths. `startServer` accepts
  `tls: { cert, key }` — the operator's PEM certificate chain and key as
  content strings, validated at startup (certificate parses, key parses, the
  pair matches; one coded `invalid_argument` before any listener exists,
  never a runtime handshake mystery) — and builds
  `https.createServer({ cert, key }, handler)` around the SAME
  `handleRequest` callback, so the native `node:https` path and a
  reverse-proxy front serve one handler structurally. The loopback-only bind
  refusal now applies exactly when no tls is given: plaintext remains
  permitted only on loopback (AD-11), while with TLS material the operator
  may bind any host. The direct launch reads the strict topology env —
  `AGENT_ROOM_HOST` / `AGENT_ROOM_PORT` / `AGENT_ROOM_TLS_CERT` /
  `AGENT_ROOM_TLS_KEY` (absolute paths to the PEM files, read through the
  bounded regular-file reader, both-or-neither): topology never falls back —
  junk fails startup with one coded line and exit 1 — and a non-loopback
  bind on the default shared data dir draws one advisory line to use a
  dedicated `AGENT_ROOM_DATA_DIR`. `agent-room remote enroll <invite-token>`
  joins the remote command family on the shared CLI host: it requires the
  configured origin, signs the exact invite-token bytes with the
  installation keypair (the frozen enroll route's possession proof), POSTs
  once over default-verification HTTPS, prints one token-redacted JSON
  receipt (the origin, the fingerprint, the token's digest prefix — never
  the token), and unlocks the already-live challenge lane (a committed
  enrollment needs no invite again; refused attempts consume nothing and are
  retryable). The self-hosting deployment guide lands at
  `docs/self-hosting-deployment.md` — both TLS paths (the Caddy recipe
  pinned to v2.11.x, with proxy timeouts ≥ 30 s over the 20 s hold, and the
  native launch), the loopback-only plaintext backend rule, the start
  boundary, certificate acquisition/renewal responsibility, key permissions
  (0600), restart-with-preserved-enrollment, no-secrets-in-logging, a
  failure-mode appendix with symptom/cause/recovery for every row, and a
  per-path evidence checklist (the enrollment receipt + the 20-second read
  capture). The AR-15 pins travel with the MCP surface: the README's tool
  section now carries the MCP stdio spec revision 2026-07-28, and the stale
  "remote and multi-host rooms are not part of version 0.2" line is replaced
  with the shipped Remote Mode reality.

### Removed

- The v0.1 MCP tool surface (`room_create`/`room_join`) that spoke the unix-socket daemon.
  The retired daemon modules remain in the repository untouched pending Epic 2/5 decisions;
  nothing in production spawns them anymore.

## 0.1.0 - 2026-08-31

- Add the Agent Plugins 1.0.0 package and generated Claude Code compatibility package.
- Add the MCP chat-room service and read-only live web viewer.
