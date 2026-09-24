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

// Presence.
export const PRESENCE_HEARTBEAT_SECONDS = 60
export const PRESENCE_HEARTBEAT_JITTER = 0.1
export const PRESENCE_TTL_SECONDS = 180
export const OFFLINE_RECENT_SECONDS = 24 * 60 * 60

// Invites and sessions.
export const INVITE_MAX_USES = 1
export const INVITE_TTL_SECONDS = 24 * 60 * 60
export const SESSION_TTL_SECONDS = 12 * 60 * 60

// Duplicate gate and reconnect backoff.
export const DUPLICATE_WINDOW_MS = 5_000
export const RECONNECT_BACKOFF_MIN_SECONDS = 1
export const RECONNECT_BACKOFF_MAX_SECONDS = 60

// Storage gates: warn below 1 GiB free, refuse appends below 256 MiB free.
export const STORAGE_WARN_FREE_BYTES = 1024 ** 3
export const STORAGE_REFUSE_FREE_BYTES = 256 * 1024 ** 2

// Held cache and viewer freshness.
export const HELD_CACHE_MAX = 100
export const VIEWER_FRESHNESS_SECONDS = 5

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

// --- File bounds -------------------------------------------------------------

// Private-key PEM files live beside identity.json and follow the same
// ratified bounded-regular-file discipline.
export const KEYPAIR_FILE_MAX_BYTES = 4096

// --- v0.1 viewer static assets ----------------------------------------------

export const WEB_ASSET_MAX_BYTES = 1024 * 1024

// --- Wire contract -----------------------------------------------------------

export const PROTOCOL_HEADER = 'Agent-Room-Protocol'
export const PROTOCOL_VERSION = '1'

// Send-status enum: basic statuses only; the full set completes in Epic 4 and
// extends this list additively.
export const SEND_STATUSES = Object.freeze([
  'committed',
  'client_message_id_conflict',
])

// Public error codes with their canonical human message. Seeded from v0.1 and
// extended additively: the table owns every wire-visible error code, so later
// stories register new codes here instead of restating messages per-route.
export const PUBLIC_ERRORS = Object.freeze({
  actor_not_member: 'actor is not a member of this room',
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
  invalid_reply_to_seq: 'reply target is invalid',
  invalid_room_id: 'room id is invalid',
  invalid_text: 'message text is invalid',
  invalid_title: 'room title is invalid',
  message_frame_too_large: 'message cannot fit the daemon frame',
  message_not_found: 'message was not found',
  node_version_unsupported: 'Node runtime is unsupported',
  reply_room_mismatch: 'reply target belongs to another room',
  request_cancelled: 'request was cancelled',
  request_too_large: 'request is too large',
  room_not_found: 'room was not found',
  sqlite_version_unsupported: 'SQLite runtime is unsupported',
})

// HTTP status for every public error code: invalid_* 400, not_found 404,
// forbidden/not-member 403, conflict 409, oversized/cancelled request 400
// (chosen over nginx's non-standard 499), busy start 503, runtime/data-dir/
// identity-key failures 500. Declared once here — never per-route.
export const PUBLIC_ERROR_STATUS = Object.freeze({
  actor_not_member: 403,
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
  invalid_reply_to_seq: 400,
  invalid_room_id: 400,
  invalid_text: 400,
  invalid_title: 400,
  message_frame_too_large: 400,
  message_not_found: 404,
  node_version_unsupported: 500,
  reply_room_mismatch: 400,
  request_cancelled: 400,
  request_too_large: 400,
  room_not_found: 404,
  sqlite_version_unsupported: 500,
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
