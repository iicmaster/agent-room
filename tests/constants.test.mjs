import assert from 'node:assert/strict'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  CHAT_ID_MAX,
  CLIENT_MESSAGE_ID_MAX,
  DISPLAY_NAME_MAX,
  DUPLICATE_WINDOW_MS,
  ENROLLMENT_BURST,
  ENROLLMENT_PER_MINUTE,
  FRAME_MAX_BYTES,
  HELD_CACHE_MAX,
  IDENTIFIER_MAX,
  INTERNAL_ERROR_CODES,
  INVITE_MAX_USES,
  INVITE_TTL_SECONDS,
  KEYPAIR_FILE_MAX_BYTES,
  MESSAGE_TEXT_MAX,
  OFFLINE_RECENT_SECONDS,
  PRESENCE_HEARTBEAT_JITTER,
  PRESENCE_HEARTBEAT_SECONDS,
  PRESENCE_TTL_SECONDS,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  PUBLIC_ERRORS,
  PUBLIC_ERROR_STATUS,
  READ_HOLD_MAX_MS,
  READ_PAGE_MAX,
  RECONNECT_BACKOFF_MAX_SECONDS,
  RECONNECT_BACKOFF_MIN_SECONDS,
  REQUEST_BUDGET_BURST,
  REQUEST_BUDGET_PER_MINUTE,
  ROOM_ID_ENTROPY_BYTES,
  SEND_STATUSES,
  SEND_TOKEN_CAPACITY,
  SEND_TOKEN_REFILL_PER_SECOND,
  SSE_BACKLOG_MAX_BYTES,
  SSE_BACKLOG_MAX_MESSAGES,
  SSE_KEEP_ALIVE_SECONDS,
  SESSION_TTL_SECONDS,
  STORAGE_REFUSE_FREE_BYTES,
  STORAGE_WARN_FREE_BYTES,
  STORE_OPEN_BUSY_BACKOFF_MS,
  STORE_OPEN_BUSY_RETRY_LIMIT,
  SUPPORTED_PROTOCOL_VERSIONS,
  TITLE_MAX,
  VIEWER_FRESHNESS_SECONDS,
  WEB_ASSET_MAX_BYTES,
} from '../server/constants.mjs'
import { DATABASE_LIMITS } from '../server/database.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// This file is the one place allowed to pin the literal values; every other
// module must import limits by name instead of restating them.
const LIMIT_LITERAL_PATTERN = new RegExp([
  '32 \\* 1024',
  '512 \\* 1024',
  '1024 \\* 1024',
  '1024 \\*\\* ?2',
  '1024 \\*\\* ?3',
  '20_000',
  '(?<![\\d.])20000(?![\\d.])',
  '(?<![\\d.])1048576(?![\\d.])',
  '(?<![\\d.])524288(?![\\d.])',
  '(?<![\\d.])32768(?![\\d.])',
].join('|'))

// Symlink-safe walk: never follows links (dangling or cyclic) and tolerates
// entries that vanish mid-scan.
function listModules(directory) {
  const found = []
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return found
    throw error
  }
  for (const name of names.sort()) {
    const path = join(directory, name)
    let info
    try {
      info = lstatSync(path)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) found.push(...listModules(path))
    else if (name.endsWith('.mjs')) found.push(path)
  }
  return found
}

test('AD-9 limits are owned once with their ratified values', () => {
  assert.equal(MESSAGE_TEXT_MAX, 32 * 1024)
  assert.equal(FRAME_MAX_BYTES, 1024 * 1024)
  assert.equal(READ_PAGE_MAX, 200)
  assert.equal(READ_HOLD_MAX_MS, 20_000)
  assert.equal(SEND_TOKEN_REFILL_PER_SECOND, 0.5)
  assert.equal(SEND_TOKEN_CAPACITY, 10)
  assert.equal(REQUEST_BUDGET_PER_MINUTE, 120)
  assert.equal(REQUEST_BUDGET_BURST, 30)
  assert.equal(ENROLLMENT_PER_MINUTE, 5)
  assert.equal(ENROLLMENT_BURST, 5)
  assert.equal(PRESENCE_HEARTBEAT_SECONDS, 60)
  assert.equal(PRESENCE_HEARTBEAT_JITTER, 0.1)
  assert.equal(PRESENCE_TTL_SECONDS, 180)
  assert.equal(INVITE_MAX_USES, 1)
  assert.equal(INVITE_TTL_SECONDS, 24 * 60 * 60)
  assert.equal(SESSION_TTL_SECONDS, 12 * 60 * 60)
  assert.equal(DUPLICATE_WINDOW_MS, 5_000)
  assert.equal(STORAGE_WARN_FREE_BYTES, 1024 ** 3)
  assert.equal(STORAGE_REFUSE_FREE_BYTES, 256 * 1024 ** 2)
  assert.equal(RECONNECT_BACKOFF_MIN_SECONDS, 1)
  assert.equal(RECONNECT_BACKOFF_MAX_SECONDS, 60)
  assert.equal(HELD_CACHE_MAX, 100)
  assert.equal(OFFLINE_RECENT_SECONDS, 24 * 60 * 60)
  assert.equal(VIEWER_FRESHNESS_SECONDS, 5)
  assert.equal(SSE_KEEP_ALIVE_SECONDS, 30)
  assert.equal(SSE_BACKLOG_MAX_MESSAGES, 50)
  assert.equal(SSE_BACKLOG_MAX_BYTES, 512 * 1024)
})

test('identifier bounds cover client_message_id, display name, title, and chat ids', () => {
  assert.equal(IDENTIFIER_MAX, 128)
  assert.equal(CLIENT_MESSAGE_ID_MAX, 128)
  assert.equal(DISPLAY_NAME_MAX, 80)
  assert.equal(TITLE_MAX, 120)
  assert.equal(CHAT_ID_MAX, 32)
  assert.equal(KEYPAIR_FILE_MAX_BYTES, 4096)
})

test('v0.1 limit groupings re-point to the constants module', () => {
  assert.deepEqual(DATABASE_LIMITS, {
    actorId: IDENTIFIER_MAX,
    clientMessageId: CLIENT_MESSAGE_ID_MAX,
    displayName: DISPLAY_NAME_MAX,
    title: TITLE_MAX,
    messageText: MESSAGE_TEXT_MAX,
    readLimit: READ_PAGE_MAX,
  })
  assert.ok(Object.isFrozen(DATABASE_LIMITS))
})

test('every v0.1 public error code has an HTTP status declared once', () => {
  const codes = Object.keys(PUBLIC_ERRORS).sort()
  assert.deepEqual(codes, [
    'actor_not_member',
    'client_message_id_conflict',
    'daemon_start_busy',
    'daemon_start_failed',
    'daemon_start_lock_invalid',
    'data_directory_invalid',
    'database_schema_unsupported',
    'identity_key_invalid',
    'invalid_actor_id',
    'invalid_chat_id',
    'invalid_client_message_id',
    'invalid_cursor',
    'invalid_display_name',
    'invalid_limit',
    'invalid_protocol',
    'invalid_reply_to_seq',
    'invalid_request',
    'invalid_room_id',
    'invalid_text',
    'invalid_title',
    'message_frame_too_large',
    'message_not_found',
    'node_version_unsupported',
    'protocol_required',
    'reply_room_mismatch',
    'request_cancelled',
    'request_failed',
    'request_too_large',
    'room_not_found',
    'route_not_found',
    'sqlite_version_unsupported',
    'unauthorized',
    'unknown_field',
  ])
  assert.deepEqual(Object.keys(PUBLIC_ERROR_STATUS).sort(), codes)
  const expectedStatus = {
    invalid_actor_id: 400,
    invalid_client_message_id: 400,
    invalid_cursor: 400,
    invalid_display_name: 400,
    invalid_limit: 400,
    invalid_reply_to_seq: 400,
    invalid_room_id: 400,
    invalid_text: 400,
    invalid_title: 400,
    message_not_found: 404,
    room_not_found: 404,
    actor_not_member: 403,
    client_message_id_conflict: 409,
    data_directory_invalid: 500,
    database_schema_unsupported: 500,
    sqlite_version_unsupported: 500,
    reply_room_mismatch: 400,
    message_frame_too_large: 400,
    request_too_large: 400,
    request_cancelled: 400,
    daemon_start_busy: 503,
    daemon_start_failed: 500,
    daemon_start_lock_invalid: 500,
    node_version_unsupported: 500,
    identity_key_invalid: 500,
    invalid_chat_id: 400,
    // Story 1.3: protocol gate, field shape, unknown-route fallback, session.
    invalid_protocol: 400,
    invalid_request: 400,
    protocol_required: 400,
    request_failed: 500,
    route_not_found: 404,
    unauthorized: 401,
    unknown_field: 400,
  }
  for (const [code, status] of Object.entries(expectedStatus)) {
    assert.equal(PUBLIC_ERROR_STATUS[code], status, code)
  }
  for (const status of Object.values(PUBLIC_ERROR_STATUS)) {
    assert.ok(Number.isInteger(status) && status >= 400 && status <= 599)
  }
  assert.ok(Object.isFrozen(PUBLIC_ERRORS))
  assert.ok(Object.isFrozen(PUBLIC_ERROR_STATUS))
})

test('send-status enum and protocol header are the frozen wire contract', () => {
  assert.deepEqual([...SEND_STATUSES], ['committed', 'client_message_id_conflict'])
  assert.ok(Object.isFrozen(SEND_STATUSES))
  assert.equal(PROTOCOL_HEADER, 'Agent-Room-Protocol')
  assert.equal(PROTOCOL_VERSION, '1')
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ['1'])
  assert.ok(Object.isFrozen(SUPPORTED_PROTOCOL_VERSIONS))
})

test('internal error codes are declared once and disjoint from the public table', () => {
  assert.deepEqual([...INTERNAL_ERROR_CODES], [
    'database_busy',
    'database_configuration_failed',
    'database_schema_invalid',
    'invalid_argument',
    'realm_already_minted',
    'store_connection_closed',
    'wal_unavailable',
  ])
  assert.ok(Object.isFrozen(INTERNAL_ERROR_CODES))
  const publicCodes = new Set(Object.keys(PUBLIC_ERRORS))
  for (const code of INTERNAL_ERROR_CODES) {
    assert.equal(publicCodes.has(code), false, `${code} must not be public`)
  }
})

test('schema-v2 store internals are declared once and distinct from reconnect backoff', () => {
  assert.equal(STORE_OPEN_BUSY_RETRY_LIMIT, 8)
  assert.equal(STORE_OPEN_BUSY_BACKOFF_MS, 25)
  assert.equal(ROOM_ID_ENTROPY_BYTES, 16)
  // Separate knobs from the public RECONNECT_BACKOFF_* pair: the store's
  // synchronous open retry and client reconnect backoff never share values.
  assert.notEqual(STORE_OPEN_BUSY_RETRY_LIMIT, RECONNECT_BACKOFF_MAX_SECONDS)
  assert.notEqual(STORE_OPEN_BUSY_BACKOFF_MS, RECONNECT_BACKOFF_MIN_SECONDS)
})

test('no limit literal is restated outside the constants module', () => {
  const offenders = []
  for (const directory of [join(ROOT, 'server'), join(ROOT, 'tests')]) {
    for (const path of listModules(directory)) {
      const relativePath = relative(ROOT, path)
      if (relativePath === join('server', 'constants.mjs')) continue
      if (relativePath === join('tests', 'constants.test.mjs')) continue
      let source
      try {
        source = readFileSync(path, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      const lines = source.split('\n')
      lines.forEach((line, index) => {
        if (LIMIT_LITERAL_PATTERN.test(line)) {
          offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`)
        }
      })
    }
  }
  assert.deepEqual(offenders, [])
})
