// Single source of truth for every numeric limit (AD-9) and the PUBLIC_ERRORS
// HTTP-status table. The only file in the repository allowed to state these
// numbers; every enforcement point imports them by name and never restates a
// literal. Later stories extend these tables additively — they never restate
// a status or a bound per-route.

// --- AD-9 limits -----------------------------------------------------------

// Message text and transport frames.
export const MESSAGE_TEXT_MAX = 32 * 1024
export const FRAME_MAX_BYTES = 1024 * 1024

// Reads: cursor pagination and long-poll hold.
export const READ_PAGE_MAX = 200
export const READ_HOLD_MAX_MS = 20_000

// Sends: token bucket refill and capacity.
export const SEND_TOKEN_REFILL_PER_SECOND = 0.5
export const SEND_TOKEN_CAPACITY = 10

// Request budgets: per key, per IP for enrollment.
export const REQUEST_BUDGET_PER_MINUTE = 120
export const REQUEST_BUDGET_BURST = 30
export const ENROLLMENT_PER_MINUTE = 5
export const ENROLLMENT_BURST = 5
// Story 4.2: the fixed window the enroll route's minimal limiter counts over
// — the "per minute" of ENROLLMENT_PER_MINUTE. The fixed window admits at
// most ENROLLMENT_PER_MINUTE requests per client identity per window, which
// for the ratified 5/min burst-5 pair realizes the declared burst exactly; a
// future retune that splits the pair belongs to Story 4.4's budget stage.
export const ENROLLMENT_WINDOW_MS = 60_000

// Presence.
export const PRESENCE_HEARTBEAT_SECONDS = 60
export const PRESENCE_HEARTBEAT_JITTER = 0.1
export const PRESENCE_TTL_SECONDS = 180
export const OFFLINE_RECENT_SECONDS = 24 * 60 * 60

// Invites and sessions.
export const INVITE_MAX_USES = 1
export const INVITE_TTL_SECONDS = 24 * 60 * 60
export const SESSION_TTL_SECONDS = 12 * 60 * 60

// Story 4.2: the invite token's shape (FR-14). A token is INVITE_TOKEN_PREFIX
// plus exactly INVITE_TOKEN_CHARS base64url characters — the canonical
// unpadded encoding of INVITE_TOKEN_BYTES (32) random bytes. Only the SHA-256
// digest of those 32 bytes is ever persisted (server/store/invites.mjs); the
// raw token is shown exactly once at mint and never appears in a listing, an
// error, or a diagnostic. The pattern gates a presented token before any
// digest work, declared once here beside the other identifier shapes.
export const INVITE_TOKEN_PREFIX = 'ar_inv1_'
export const INVITE_TOKEN_BYTES = 32
export const INVITE_TOKEN_CHARS = 43
export const INVITE_TOKEN_PATTERN = new RegExp(
  `^${INVITE_TOKEN_PREFIX}[A-Za-z0-9_-]{${INVITE_TOKEN_CHARS}}$`,
)
// Story 4.2: the digest prefix an operator sees in `invite list` and types
// into `invite revoke`. Twelve hex characters (48 bits of the stored SHA-256
// digest) identify an invite without ever exposing a secret-shaped value; a
// revoke argument below this length is a usage refusal, and a prefix matching
// several invites is refused with the candidate prefixes — never a guess.
export const INVITE_DIGEST_PREFIX_CHARS = 12

// Story 4.1: the remote challenge path's bounds (AD-5/AD-7). The nonce is 32
// random bytes minted base64url (43 characters — AD-7 requires only ≥16, the
// declared bound is stricter and stated once here); a pending challenge
// expires CHALLENGE_NONCE_TTL_MS after issue and the pending set is capped at
// CHALLENGE_NONCES_MAX with the session registry's sweep-then-evict
// discipline. A presented signature longer than CHALLENGE_SIGNATURE_MAX_CHARS
// can never be a valid Ed25519 signature (64 bytes → 86 base64url
// characters) and is refused before any verify work, mirroring the session
// token's presented-credential cap.
export const CHALLENGE_NONCE_BYTES = 32
export const CHALLENGE_NONCE_TTL_MS = 60_000
export const CHALLENGE_NONCES_MAX = 1000
export const CHALLENGE_SIGNATURE_MAX_CHARS = 256
// Story 4.1 review triage: the canonical base64url wire form of a 64-byte
// Ed25519 signature — 86 characters of the base64url alphabet, unpadded. The
// base64url decoder silently SKIPS interspersed invalid characters, so a
// decorated spelling (the canonical 86 characters plus any junk the length
// bound above tolerates) would decode to the very bytes a canonical spelling
// carries. The answer route gates on this exact shape before decoding, so
// only canonical credentials are ever honored. The shape is stated once here
// (AD-9) beside the bounds it gates, derived from nothing else — 64 bytes is
// Ed25519's signature size, and 4/3 of it minus padding is 86.
export const CHALLENGE_SIGNATURE_CHARS = 86
export const CHALLENGE_SIGNATURE_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${CHALLENGE_SIGNATURE_CHARS}}$`,
)

// Duplicate gate and reconnect backoff.
export const DUPLICATE_WINDOW_MS = 5_000
export const RECONNECT_BACKOFF_MIN_SECONDS = 1
export const RECONNECT_BACKOFF_MAX_SECONDS = 60

// Storage gates: warn below 1 GiB free, refuse appends below 256 MiB free.
// Story 4.6: both are tunable capacity RESERVES (operator knobs), never
// retention quotas — the log is append-only and nothing is ever deleted to
// free space. The warn's rate limit is the minimum interval between two
// storage-low warn lines on one store connection: the line is a hint an
// operator must be able to read in a log, not one per append.
export const STORAGE_WARN_FREE_BYTES = 1024 ** 3
export const STORAGE_REFUSE_FREE_BYTES = 256 * 1024 ** 2
export const STORAGE_WARN_INTERVAL_MS = 60_000

// Held cache and viewer freshness.
export const HELD_CACHE_MAX = 100
export const VIEWER_FRESHNESS_SECONDS = 5

// --- Story 5.1: the viewer surface (FR-18, HCI-5) ----------------------------

// The viewer credential shapes. The viewer token is the 0600 `viewer-token`
// file in the shared data dir: 32 random bytes (43 base64url characters)
// generated by loadOrCreateViewerToken, with headroom for operator-provisioned
// credentials of the same alphabet — the exact bounds the loader has enforced
// since the file's introduction, now stated once here. The auth bridge
// (`GET /viewer/auth`, Bearer) exchanges it for a cookie; the cookie value is
// an independent 256-bit random base64url value (never the token itself), and
// the cookie registry holds only its digest. Rotation replaces the file; the
// bridge's per-request read of the file is what makes a rotated token refuse
// at the very next mint and every existing cookie invalid at its next
// presentation (FR-18's viewer token rotation).
export const VIEWER_TOKEN_MIN_CHARS = 32
export const VIEWER_TOKEN_MAX_CHARS = 256
export const VIEWER_TOKEN_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${VIEWER_TOKEN_MIN_CHARS},${VIEWER_TOKEN_MAX_CHARS}}$`,
)
export const VIEWER_COOKIE_BYTES = 32
export const VIEWER_COOKIE_NAME = 'agent_room_viewer'
// The cookie is path-scoped to the viewer surface: a browser never carries it
// onto any other path on the host, whatever an HTML injection may try.
export const VIEWER_COOKIE_PATH = '/viewer'
// The in-memory cookie registry's capacity (the session registry's bound,
// sized for a human-scale viewer surface). Capacity evicts
// oldest-inserted-then-live; rotation and restart clear validity wholesale.
export const VIEWER_SESSIONS_MAX = 100

// Server-sent events: keep-alive comment cadence and replay backlog bounds.
export const SSE_KEEP_ALIVE_SECONDS = 30
export const SSE_BACKLOG_MAX_MESSAGES = 50
export const SSE_BACKLOG_MAX_BYTES = 512 * 1024

// --- Identifier bounds -----------------------------------------------------

// Generic v0.1 actor and room identifiers.
export const IDENTIFIER_MAX = 128
export const CLIENT_MESSAGE_ID_MAX = 128
export const DISPLAY_NAME_MAX = 80
export const TITLE_MAX = 120
export const CHAT_ID_MAX = 32
// DR-1 chat id grammar: 1-CHAT_ID_MAX characters of [A-Za-z0-9_.-]. Derived
// from CHAT_ID_MAX so the bound is stated once (AD-9). Comparison and
// uniqueness are case-insensitive: the normalized form is the lowercase chat
// id and the display form preserves the caller's case.
export const CHAT_ID_PATTERN = new RegExp(`^[A-Za-z0-9_.-]{1,${CHAT_ID_MAX}}$`)
// Canonical DR-1 grammar gate and rejection detail, shared verbatim by the
// store's requireChatId and the live-session registry (one validation point;
// callers attach their own coded error to the null result). Non-strings are
// invalid: the gate never coerces.
export function chatIdForms(value) {
  if (typeof value !== 'string' || !CHAT_ID_PATTERN.test(value)) return null
  return Object.freeze({ display: value, normalized: value.toLowerCase() })
}
export const CHAT_ID_INVALID_MESSAGE = `chat_id must be 1-${CHAT_ID_MAX} characters using letters, numbers, dot, underscore, or hyphen`

// Canonical Actor fingerprint shape (see ./keys.mjs): `sha256:` plus 64
// lowercase hex characters over the raw 32-byte Ed25519 public key. Declared
// once here beside the other identifier shapes; every module that handles
// fingerprints imports these instead of restating them.
export const FINGERPRINT_PREFIX = 'sha256:'
export const FINGERPRINT_HEX_LENGTH = 64
export const FINGERPRINT_PATTERN = new RegExp(
  `^${FINGERPRINT_PREFIX}[0-9a-f]{${FINGERPRINT_HEX_LENGTH}}$`,
)

// The safe realm-key shape (Story 3.2, shared with the cursor paths): the only
// characters allowed into a path segment under PLUGIN_DATA/realms/. The realm
// id comes from GET /api/status and keys per-realm client state directories,
// so its shape is verified before any path is built from it. Declared once
// beside the other identifier shapes; the MCP adapter's cursor paths and the
// per-realm allowlist paths import this instead of restating it.
export const REALM_KEY_PATTERN = /^[A-Za-z0-9._-]+$/

// --- File bounds -------------------------------------------------------------

// Private-key PEM files live beside identity.json and follow the same
// ratified bounded-regular-file discipline.
export const KEYPAIR_FILE_MAX_BYTES = 4096

// --- v0.1 viewer static assets ----------------------------------------------

export const WEB_ASSET_MAX_BYTES = 1024 * 1024

// --- Wire contract -----------------------------------------------------------

export const PROTOCOL_HEADER = 'Agent-Room-Protocol'
export const PROTOCOL_VERSION = '1'

// Versions the protocol stage accepts on /api/* requests; additive-only per
// NFR-8 (a mangled or unsupported header names this list in the error).
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([PROTOCOL_VERSION])

// Send-status enum (FR-17, Story 4.4: the complete set). Every send the
// server processes answers with exactly one of these — `committed` and
// `duplicate_dropped` as 200 results (the latter naming original_seq),
// `rate_limited` as the coded 429 carrying retry_after_ms,
// `client_message_id_conflict` as the coded 409, and `banned`/`storage_low`
// as the coded refusals Stories 4.5/4.6 wire by name when their triggers
// land. Landed: `banned` is Story 4.5's 403 authz refusal; `storage_low` is
// Story 4.6's append-gate refusal, answered on the send route as a 200
// result {status:'storage_low'} — an explicit, never-acknowledged notice
// (the store wrote nothing), not an error the sender should retry against.
// Names never rename; the set is closed at these six.
export const SEND_STATUSES = Object.freeze([
  'committed',
  'rate_limited',
  'duplicate_dropped',
  'storage_low',
  'client_message_id_conflict',
  'banned',
])

// Public error codes with their canonical human message. Seeded from v0.1 and
// extended additively: the table owns every wire-visible error code, so later
// stories register new codes here instead of restating messages per-route.
export const PUBLIC_ERRORS = Object.freeze({
  actor_not_member: 'actor is not a member of this room',
  ambiguous_chat_id: 'chat id is claimed by multiple actors; retry with one candidate fingerprint as target_fingerprint',
  // Story 4.5: the operator ban's refusal — every send, read, or re-enroll
  // from a banned key answers this code (the send-status enum's `banned`
  // taking its wire face here, as rate_limited did before it).
  banned: 'this key is banned by the operator',
  chat_id_not_found: 'no actor has claimed this chat id',
  chat_id_taken: 'chat id is already claimed by another connected session',
  // Story 7.2 (the observed incumbent): the one code every stale conflict
  // observation answers — unknown, expired, already consumed, wrong Actor,
  // wrong name, or the occupancy pair moved (including the name going free
  // and being re-claimed by the SAME key). Collapsing the shapes prevents
  // fine-grained state leaks while giving the operator one clear meaning:
  // observe again, then confirm.
  conflict_stale: 'the conflict ticket is invalid, expired, already consumed, or does not match the current incumbent',
  // Story 4.1: the challenge nonce is missing, expired, already consumed, or
  // evicted — the single code every no-longer-answerable challenge answers.
  challenge_invalid: 'challenge nonce is invalid, expired, or already used',
  client_message_id_conflict: 'client_message_id was already used for different content',
  daemon_start_busy: 'another agent-room daemon start did not finish',
  daemon_start_failed: 'agent-room daemon did not become ready',
  daemon_start_lock_invalid: 'agent-room daemon start lock is not a bounded regular file',
  data_directory_invalid: 'agent-room data directory is invalid',
  database_schema_unsupported: 'database schema is not supported by this agent-room version',
  identity_key_invalid: 'agent-room identity key is invalid',
  invalid_actor_id: 'actor id is invalid',
  invalid_chat_id: 'chat id is invalid',
  invalid_client_message_id: 'client_message_id is invalid',
  invalid_cursor: 'message cursor is invalid',
  invalid_display_name: 'display name is invalid',
  invalid_limit: 'message limit is invalid',
  invalid_protocol: 'Agent-Room-Protocol header version is not supported',
  invalid_reply_to_seq: 'reply target is invalid',
  invalid_request: 'request shape is invalid',
  invalid_room_id: 'room id is invalid',
  invalid_text: 'message text is invalid',
  invalid_title: 'room title is invalid',
  invalid_wait_ms: 'wait_ms is invalid',
  // Story 4.2: the invite gate — a well-formed token that is unknown,
  // expired, or revoked; an invite whose uses are spent by other keys; and
  // the operator's revoke-prefix miss.
  invite_exhausted: 'invite has no uses remaining',
  invite_invalid: 'invite token is unknown, expired, or revoked',
  invite_not_found: 'no invite matches this digest prefix',
  local_token_invalid: 'agent-room local token is missing or invalid',
  message_frame_too_large: 'message cannot fit the daemon frame',
  message_not_found: 'message was not found',
  node_version_unsupported: 'Node runtime is unsupported',
  // Story 4.1: the answer route's enrollment gate — a key that holds no
  // durable enrollment record can prove possession and still mint no session.
  not_enrolled: 'this public key is not enrolled on this server',
  protocol_required: 'Agent-Room-Protocol header is required',
  // Story 4.2: the enroll route's admission refusal — the minimal fixed-
  // window counter that paces POST /api/auth/enroll at ENROLLMENT_PER_MINUTE
  // per client identity. The full request-budget policy (counting every
  // route, per key) is Story 4.4's and extends from this code.
  rate_limited: 'request rate limit exceeded',
  reply_room_mismatch: 'reply target belongs to another room',
  request_cancelled: 'request was cancelled',
  request_failed: 'agent-room request failed',
  request_too_large: 'request is too large',
  room_not_found: 'room was not found',
  route_not_found: 'route was not found',
  server_port_conflict: 'agent-room server port is held by another process',
  server_start_busy: 'another agent-room server start did not finish',
  server_start_failed: 'agent-room server did not become ready',
  server_start_lock_invalid: 'agent-room server start lock is not a bounded regular file',
  // Story 4.1: the Ed25519 verification against the challenge-recorded key
  // failed — identity binds at challenge time and cannot be substituted.
  signature_invalid: 'signature verification failed',
  sqlite_version_unsupported: 'SQLite runtime is unsupported',
  // Story 4.6: the storage admission gate's refusal — free space below the
  // configured refuse reserve, or the disk-full write itself. The send route
  // answers the FR-17 status (a 200 result {status:'storage_low'} naming a
  // send that was never committed and is never acknowledged); this coded face
  // keeps the refusal named and diagnosable wherever a store refusal surfaces
  // outside that route, instead of collapsing into request_failed.
  storage_low: 'storage is below the configured free-space reserve',
  unauthorized: 'session authentication is required',
  unknown_field: 'request contains an unknown field',
})

// HTTP status for every public error code: invalid_* 400, not_found 404,
// forbidden/not-member 403, conflict 409, oversized/cancelled request 400
// (chosen over nginx's non-standard 499), busy start 503, runtime/data-dir/
// identity-key failures 500. Story 1.3 additions: protocol/field-shape
// rejections 400, unknown routes and routes without a registered handler 404
// (route_not_found), and request_failed 500 — request_failed keeps only the
// AD-8 "unknown error code" fallback role, and an internal fault must not
// masquerade as a missing route. Story 1.4 additions: a missing or unusable
// local credential file is a credential-class failure answered 401
// (local_token_invalid, never created from the HTTP path), the bootstrap
// engine's busy start mirrors daemon_start_busy (server_start_busy, 503),
// startup and lock failures are 500, and a runtime record whose port a
// foreign process holds is a conflicted state (server_port_conflict, 409)
// that is never auto-killed. Story 1.5 addition: a live-name collision is a
// conflicted state answered 409 (chat_id_taken) — refused explicitly, never
// suffixed or auto-mangled. Story 1.7 additions: a chat id with no durable
// claim is a miss answered 404 (chat_id_not_found — never a guess), a
// long-poll hold outside its window is a shape rejection answered 400
// (invalid_wait_ms — the hold bound is READ_HOLD_MAX_MS), and a name claimed
// by several Actors is a conflicted state answered 409 (ambiguous_chat_id)
// that carries the candidates list in the error envelope for
// target_fingerprint disambiguation. Story 4.1 additions: a challenge nonce
// that is missing, expired, already consumed, or evicted is a
// credential-class failure answered 401 (challenge_invalid), a failed Ed25519
// verification against the challenge-recorded key is answered 401
// (signature_invalid), and a key with no durable enrollment record is
// answered 403 (not_enrolled — the answer route's gate, even with a proven
// signature). Story 4.2 additions: an unknown, expired, or revoked (but
// well-formed) invite is a credential-class failure answered 403
// (invite_invalid), an invite whose uses other keys spent is a conflicted
// state answered 409 (invite_exhausted — the race loser's coded answer), a
// revoke prefix matching no invite is a miss answered 404
// (invite_not_found), and the enroll route's admission refusal is answered
// 429 (rate_limited — the send-status code's HTTP face arrives here first;
// Story 4.4's budget stage reuses the code per-route). Story 4.5 addition:
// a banned key's refusal on any send, read, or re-enroll is a
// credential-class failure answered 403 (banned — the send-status code's
// HTTP face; the operator ban is the actor equivalent of actor_not_member).
// Declared once here — never per-route.
export const PUBLIC_ERROR_STATUS = Object.freeze({
  actor_not_member: 403,
  ambiguous_chat_id: 409,
  banned: 403,
  chat_id_not_found: 404,
  chat_id_taken: 409,
  conflict_stale: 409,
  challenge_invalid: 401,
  client_message_id_conflict: 409,
  daemon_start_busy: 503,
  daemon_start_failed: 500,
  daemon_start_lock_invalid: 500,
  data_directory_invalid: 500,
  database_schema_unsupported: 500,
  identity_key_invalid: 500,
  invalid_actor_id: 400,
  invalid_chat_id: 400,
  invalid_client_message_id: 400,
  invalid_cursor: 400,
  invalid_display_name: 400,
  invalid_limit: 400,
  invalid_protocol: 400,
  invalid_reply_to_seq: 400,
  invalid_request: 400,
  invalid_room_id: 400,
  invalid_text: 400,
  invalid_title: 400,
  invalid_wait_ms: 400,
  invite_exhausted: 409,
  invite_invalid: 403,
  invite_not_found: 404,
  local_token_invalid: 401,
  message_frame_too_large: 400,
  message_not_found: 404,
  node_version_unsupported: 500,
  not_enrolled: 403,
  protocol_required: 400,
  rate_limited: 429,
  reply_room_mismatch: 400,
  request_cancelled: 400,
  request_failed: 500,
  request_too_large: 400,
  room_not_found: 404,
  route_not_found: 404,
  server_port_conflict: 409,
  server_start_busy: 503,
  server_start_failed: 500,
  server_start_lock_invalid: 500,
  signature_invalid: 401,
  sqlite_version_unsupported: 500,
  // Story 4.6: the storage admission gate's coded face, reserved for the
  // store's storage_low refusal should it ever surface outside the send route
  // (which maps it to the FR-17 200 result per the send-status contract —
  // today the append path is the code's only producer, and message appends
  // are FR-22's scope). 507 is the Insufficient Storage class — the one HTTP
  // status whose name is this condition.
  storage_low: 507,
  unauthorized: 401,
  unknown_field: 400,
})

// Internal (never wire-visible) error codes: store and runtime invariants.
// Declared once here so every thrown code in the repository is a member of
// PUBLIC_ERRORS or this list; extended additively as internal failures gain
// coded names.
export const INTERNAL_ERROR_CODES = Object.freeze([
  'database_busy',
  'database_configuration_failed',
  'database_schema_invalid',
  'invalid_argument',
  'realm_already_minted',
  'realm_bootstrap_incomplete',
  'state_file_invalid',
  'store_connection_closed',
  'wal_unavailable',
])

// --- Schema-v2 store internals -------------------------------------------------

// Open-time busy retry for concurrent openers (server/store/room-log.mjs).
// Deliberately distinct from the public RECONNECT_BACKOFF_* pair: these tune
// the store's synchronous open path, not client reconnects.
export const STORE_OPEN_BUSY_RETRY_LIMIT = 8
export const STORE_OPEN_BUSY_BACKOFF_MS = 25

// Entropy for opaque room ids: 16 random bytes → 22 base64url characters.
export const ROOM_ID_ENTROPY_BYTES = 16

// --- Story 2.3: the one-time v0.1→v0.2 migration (server/store/migrate-v1.mjs) -

// How long a recorded live pid is given to answer GET /health before the
// migration classifies the runtime record (the v0.1 daemon writes its record
// only after its listeners are up, so a healthy daemon answers immediately;
// the window exists for a daemon caught mid-start). The per-signal escalation
// wait reuses SERVER_CHILD_REAP_TIMEOUT_MS — the same "how long a signalled
// process is given to exit" semantic the bootstrap engine already declares.
export const MIGRATION_DAEMON_SETTLE_MS = 2_000

// --- Story 1.4: local bootstrap & session auth --------------------------------

// Session tokens: the 12 h sliding TTL is provisional per DR-2 (spine Open
// Question 1 stays open until Story 4.1's data); the millisecond form derives
// from the declared SESSION_TTL_SECONDS and is what the in-memory registry
// consumes. Tokens are 256-bit (AD-5 bearer entropy); a presented credential
// longer than the character bound can never be a valid token and is rejected
// before hashing.
export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000
export const SESSION_TOKEN_BYTES = 32
export const SESSION_TOKEN_MAX_CHARS = 256
// Session registry capacity: one Actor may hold many sessions (each with its
// own Chat ID in Story 1.5), so the bound is per-realm, not per-Actor; issue()
// lazily sweeps expired entries and evicts oldest-expired-then-oldest.
export const SESSIONS_MAX = 1000

// The local bootstrap credential file (0600, shared data dir) is a bounded
// regular non-symlink file like every other private state file.
export const LOCAL_TOKEN_MAX_BYTES = 4096

// --- Story 1.5: chat id connect, rename & durable claims ----------------------

// The durable chat_id_claims index (server/store/room-log.mjs) prunes claim
// rows whose last_seen_at is older than the TTL — 7 days by default, the
// single constant an operator tunes via startServer({claimsTtlMs}). The lazy
// prune cycle paces itself on the interval between boot prunes.
export const CLAIMS_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000

// ensureServer's bootstrap engine (server/client/ensure-server.mjs). The wait
// budget deliberately exceeds the 15 s staleness window so a stale lock is
// reclaimable within one invocation; the poll/probe values pace attach
// attempts and /health readiness probes; the reap timeout bounds how long a
// failed boot waits before SIGKILL on the child it owns.
export const SERVER_STARTUP_WAIT_MS = 20_000
export const SERVER_STARTUP_LOCK_STALE_MS = 15_000
export const SERVER_STARTUP_LOCK_MAX_BYTES = 512
export const SERVER_ATTACH_POLL_MS = 50
export const SERVER_HEALTH_PROBE_TIMEOUT_MS = 750
// A /health probe reads at most this many bytes before the connection is
// destroyed — a foreign responder on the recorded port cannot flood memory.
export const SERVER_HEALTH_PROBE_MAX_BYTES = 64 * 1024

// Default ceiling for a private state file read (identity, viewer token, lock).
export const STATE_FILE_MAX_BYTES = 64 * 1024
export const SERVER_CHILD_REAP_TIMEOUT_MS = 2_000

// --- Story 3.3: the held pipeline ----------------------------------------------

// The held state file's read bound, derived (AD-9) from the bounds it carries:
// the bounded body cache holds at most HELD_CACHE_MAX body copies, each an
// untrusted-envelope-wrapped text of at most MESSAGE_TEXT_MAX characters
// (×2 headroom for the wrapper text and terminator neutralization), plus
// wrapper slack per entry and the shared private-state-file ceiling for the
// unreleased metadata records that survive body eviction. The bound is a read
// ceiling, never a retention rule: eviction drops only cached body copies.
export const HELD_STATE_MAX_BYTES
  = HELD_CACHE_MAX * (MESSAGE_TEXT_MAX * 2 + 1024) + STATE_FILE_MAX_BYTES

// --- Story 1.6: presence — online & offline-recently --------------------------

// Millisecond forms of the ratified presence windows, derived from the
// declared seconds values so each bound is stated once (AD-9). PRESENCE_TTL_MS
// is the online liveness window: a live session silent strictly longer than
// the TTL drops from the online group (read-time lease sweep). The
// offline-recently window is inclusive at its boundary — a claim last seen
// exactly OFFLINE_RECENTLY_WINDOW_MS ago is still in the group.
export const PRESENCE_TTL_MS = PRESENCE_TTL_SECONDS * 1000
export const OFFLINE_RECENTLY_WINDOW_MS = OFFLINE_RECENT_SECONDS * 1000

// The closed set of client types a session may declare at bind time (the
// additive client_type request field, Story 1.6 spine amendment). v0.1's
// MCP-client-derived naming is retired: the server never derives or guesses a
// client type — a session that binds without declaring one stays null on its
// presence row. Additive set: values join, names never rename.
export const CLIENT_TYPES = Object.freeze(['mcp', 'cli', 'api'])

// --- Story 1.7: MCP adapter, api-client, cursors & setup ----------------------

// The MCP adapter's five tools (no native-named aliases). The connecting
// session always binds with this client type; identity comes only from the
// session token — never a tool argument (NFR-3).
export const MCP_CLIENT_TYPE = 'mcp'

// api-client (server/client/api-client.mjs) request timeouts: the default
// bound for one HTTP round trip, and the margin added on top of a long-poll's
// wait_ms so the server's hold (<= READ_HOLD_MAX_MS) always wins the race
// before the client gives up.
export const CLIENT_REQUEST_TIMEOUT_MS = 10_000
export const CLIENT_LONGPOLL_MARGIN_MS = 3_000

// Story 6.4: the orderly-exit release bound. When the MCP adapter's stdin
// closes, the adapter hands its Chat ID back (DELETE /api/session) instead of
// squatting it until the lease expires. The release is best-effort and must
// never hold the exiting process open: it gets this short bound, and a
// release that does not answer in time is simply abandoned (the durable
// claim row survives either way, so only a lease is lost).
export const CLIENT_RELEASE_TIMEOUT_MS = 2_000

// Story 7.2 (the observed incumbent): the conflict ticket's lifetime and
// bounds. The TTL is the operator's confirmation window — fixed
// (non-sliding), 120 s: the CAS comparison makes staleness safe, so the
// shorter exposure window is the security default. The bounds gate NEW
// issuance only; an unexpired ticket is never evicted to make room (the
// fence's lesson), and re-observing the same (Actor, name) pair replaces
// that pair's outstanding ticket.
export const CONFLICT_TICKET_TTL_MS = 120_000
export const CONFLICT_TICKET_MAX_OUTSTANDING = 4_096
export const CONFLICT_TICKET_MAX_PER_ACTOR = 64

// Story 7.2 (release-gate findings): the occupancy-generation history is a
// bounded FIFO of per-name stamps whose EVICTED entries read null, never a
// fallback zero (the zero-ABA rule — two occupancies must never share an
// observable 0). With null semantics every observable stamp is unique and
// never reused, so the bound can only make a takeover refuse, never wrongly
// allow one, while the map stays honest against distinct-name churn.
export const GENERATION_HISTORY_MAX = 4_096

// Server-side long-poll wake-up cadence (GET /api/rooms/:id/messages): the
// handler re-polls the store at this interval inside the request — no open
// read transaction is held while waiting.
export const LONGPOLL_POLL_INTERVAL_MS = 250

// The default read page the adapter requests when the caller gives no limit;
// the page bound itself stays READ_PAGE_MAX.
export const READ_PAGE_DEFAULT = 50

// The one-time setup command's config file (PLUGIN_DATA/config.json) is a
// bounded regular non-symlink file like every other private state file; the
// MCP adapter refuses to run without it (first-run guidance) and the setup
// command writes it atomically at 0600.
export const CLIENT_CONFIG_MAX_BYTES = 4096

// Version of the static untrusted-message envelope the client wraps around a
// foreign sender's message body (sender fingerprint != the local
// installation's). Same-Actor messages return plain. The schema is frozen
// from this story forward: later changes are additive with a new version.
export const UNTRUSTED_ENVELOPE_VERSION = '1'

// --- Story 2.2: reconnection & room discovery ----------------------------------

// FR-12's reconnect backoff completes here: RECONNECT_BACKOFF_MIN_SECONDS and
// RECONNECT_BACKOFF_MAX_SECONDS (declared since the v0.1 seeding) are at last
// consumed by the api-client's bounded reconnect schedule, whose base doubles
// from the minimum and caps at the maximum. The two knobs below pace that
// schedule. The jitter is the uniform ± fraction around each base delay a
// return value may move — the schedule stays within
// [base×(1−RECONNECT_BACKOFF_JITTER), base×(1+RECONNECT_BACKOFF_JITTER)],
// rounded to whole milliseconds — and the probe cadence is how often a
// backoff wait polls the recorded server's health (read-only) so a detected
// agent-room answer cuts the wait and permits an immediate attempt. Declared
// once here (AD-9); every consumer imports them by name.
export const RECONNECT_BACKOFF_JITTER = 0.1
export const RECONNECT_RECOVERY_PROBE_MS = 250
