// The one-time v0.1 → v0.2 in-place migration (Story 2.3, AR-4).
//
// A v0.1 database (user_version 1: actors/rooms/room_members/messages with a
// GLOBAL AUTOINCREMENT messages.seq) is upgraded in place to the schema-v2
// store (rooms/direct_members/messages/realms/chat_id_claims with room-local
// contiguous sequences). The migration is ONE startup step, and its ordering
// is pinned by the architecture spine:
//
//   1. Absorb-or-stop: read runtime.json in the shared data dir; when it
//      names a live pid whose /health answers like an agent-room server,
//      that process is the v0.1 daemon — stop it (SIGTERM, bounded wait,
//      then SIGKILL) BEFORE the database is touched. A dead-and-unreachable
//      entry is just reclaimed. A process that cannot be positively
//      identified as agent-room is never signalled (a port that cleanly
//      answers non-agent-room is a coded refusal, mirroring ensure-server's
//      rule); a live pid whose port never answers falls back to SQLite's own
//      single-writer serialization rather than a kill.
//   2. A single BEGIN IMMEDIATE transaction performs detect (user_version,
//      re-read inside the transaction) → per-room re-sequencing + reply_to_seq
//      remap (global → room-local) → schema reshape to v2 → realm row →
//      stamp user_version = 2. A crash mid-migration rolls the transaction
//      back (the version stamp is part of the transactional database header),
//      so "resume" is simply re-running the same single transaction on the
//      untouched v1 file at the next boot — idempotent by construction.
//      A transaction that fails mid-copy for any reason leaves the file v1
//      and fails coded; nothing partial is ever persisted.
//   3. Realm preservation: an in-place schema migration is the SAME realm
//      with the same trust — only moving to a new server/host creates a new
//      realm (AR-14 boundary). The v0.1 file carries no realm id, so the
//      migration mints the realm's first id (a UUIDv4, like every first boot)
//      inside the migration transaction; from that commit onward the id is
//      stable for the lifetime of this data directory. The realm CONTINUES
//      even though the id is newly minted — same file, same history, same
//      local trust.
//
// Mapping decisions (documented here and in the Story 2.3 spec — the only
// places; do not scatter copies):
//
//   - Room kind: every v0.1 room migrates as kind='broadcast' with implicit
//     membership. v0.1 rooms carry no kind and no DM pair semantics — a v0.2
//     pair key needs Ed25519 fingerprints, and v0.1 actor ids are identifier
//     strings (in practice `agent:<uuid>`), NOT fingerprints. DM continuity
//     across the migration is therefore NOT promised (v0.1 had no DMs).
//     Broadcast mapping keeps every migrated commons room readable and
//     writable by every Actor, which is what v0.1's own read path allowed.
//     Room ids, titles, and created_at are preserved verbatim; the room
//     creator is NULL (v2 never fabricates an identity for a broadcast room).
//   - Message actor identity: actor_fingerprint is derived deterministically
//     as sha256:<hex> over the v1 actor id string. It preserves distinctness
//     and attribution stability, but it is NOT a live v0.2 identity — the
//     upgraded installation's Actor is its own Ed25519 key fingerprint, and
//     v0.1 had no keys. History attributes faithfully; live identity begins
//     with the v0.2 keypair.
//   - Message chat_id attribution: the v1 send-time display name is
//     deterministic-mapped into the DR-1 chat id grammar (characters outside
//     [A-Za-z0-9_.-] become '_', truncated to CHAT_ID_MAX) because the v2
//     messages.chat_id CHECK bounds length and the store's invariant is that
//     stored chat ids satisfy the grammar. History keeps the send-time name
//     to this mapped form; two long names may map onto one string, which is
//     harmless — attribution is historical, not identity.
//   - Durable chat_id_claims are NOT seeded from v1 actors: the mapped
//     fingerprint is not the key the agent will present after upgrading, so
//     offline addressing against it would resolve to a stale identity.
//     Addressing recovers when each session reconnects and re-claims.
//   - THE ONE-TIME CURSOR RESET (AR-4): client cursors are per-(installation,
//     realm, room) state under PLUGIN_DATA/realms/<realm_id>/, and migration
//     mints the realm's first id — so every pre-upgrade cursor value lives
//     outside the new realm key and is never consulted again, and room-local
//     v2 sequences start from 1 where v0.1 sequences were global. No legacy
//     cursor file is read, rewritten, or migrated; clients resume from
//     after_seq 0 in the migrated rooms. Ordinary restarts never reset
//     cursors (FR-11) — this is the only cursor reset in the product, and it
//     is documented exactly here and in the Story 2.3 spec.
//
// The raw store (./room-log.mjs) still refuses a v1 file with
// database_schema_unsupported: the store never mutates a schema it does not
// own, and refused files stay byte-for-byte untouched. Wiring lives in
// startServer, which calls migrateV1InPlace({ dataDir }) before openRoomLog.
// The refusal remains for anything that is not a v1 file (fresh v0, current
// v2, future versions, version-0 files with foreign tables, corrupt files).

import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import { chmodSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  CHAT_ID_MAX,
  FINGERPRINT_PREFIX,
  MIGRATION_DAEMON_SETTLE_MS,
  SERVER_ATTACH_POLL_MS,
  SERVER_CHILD_REAP_TIMEOUT_MS,
  SERVER_HEALTH_PROBE_MAX_BYTES,
  SERVER_HEALTH_PROBE_TIMEOUT_MS,
  STORE_OPEN_BUSY_BACKOFF_MS,
  STORE_OPEN_BUSY_RETRY_LIMIT,
} from '../constants.mjs'
import {
  AgentRoomRuntimeError,
  readJsonFile,
  runtimeRecordPath,
} from '../runtime.mjs'
import {
  ROOM_LOG_DATABASE_FILENAME,
  ROOM_LOG_SCHEMA_VERSION,
  chatIdClaimsTableDdl,
  directMembersTableDdl,
  messagesTableDdl,
  realmsTableDdl,
  roomsTableDdl,
} from './room-log.mjs'

// The v1 message columns this migration consumes, asserted before any copy
// begins so a foreign user_version-1 file fails coded instead of half-read.
const V1_TABLES = Object.freeze(['actors', 'rooms', 'room_members', 'messages'])
const V1_MESSAGE_COLUMNS = Object.freeze([
  'seq',
  'room_id',
  'actor_id',
  'actor_display_name',
  'client_message_id',
  'text',
  'reply_to_seq',
  'created_at',
])

function fail(code, message) {
  throw new AgentRoomRuntimeError(code, message)
}

function pragmaValue(database, sql) {
  const row = database.prepare(sql).get()
  return row ? Object.values(row)[0] : undefined
}

// SQLite primary result codes as reported by node:sqlite's SqliteError
// (.errcode is the numeric code; .code is Node's generic ERR_SQLITE_ERROR) —
// the same mapping room-log.mjs uses.
const SQLITE_BUSY = 5
const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

// The migration's own immediate-transaction wrapper, mirroring the store's:
// the operation result exists only after COMMIT, and any failure rolls the
// transaction back before the error propagates — the property that makes a
// crash mid-migration resume from the untouched v1 file.
function withImmediateTransaction(database, operation) {
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch (error) {
    if (error?.errcode === SQLITE_BUSY) {
      fail('database_busy', 'agent-room database write lock stayed busy; the migration never started')
    }
    throw error
  }
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the operation error; the connection will surface later failures.
    }
    throw error
  }
}

const delay = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// ESRCH means the pid is gone; EPERM means a live process owned by another
// user — either way that pid is not this user's dead record.
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// The recorded port, from either runtime-record generation: the v0.2 record
// carries `port`; the v0.1 record carries `httpOrigin`
// (`http://127.0.0.1:<port>`). A record with neither names no probeable
// listener.
function portFromRecord(record) {
  if (Number.isInteger(record.port) && record.port > 0 && record.port <= 65535) {
    return record.port
  }
  if (typeof record.httpOrigin === 'string') {
    const match = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(record.httpOrigin)
    if (match) {
      const port = Number(match[1])
      if (port > 0 && port <= 65535) return port
    }
  }
  return null
}

// One GET /health probe against the recorded port. "Answers like an
// agent-room server" spans BOTH generations: the v0.2 shape
// ({ok:true, result:{version}}) and the v0.1 shape ({ok:true, version}).
// ensure-server's probeHealth deliberately accepts only the v0.2 shape (it
// gates attach to the new server); the migration must recognize the daemon it
// is about to stop, so the v0.1 shape counts here. Body size is bounded like
// every probe in this codebase.
function probeAgentRoomHealth(port) {
  return new Promise(resolvePromise => {
    let settled = false
    let overall = null
    const finish = outcome => {
      if (settled) return
      settled = true
      clearTimeout(overall)
      resolvePromise(outcome)
    }
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        timeout: SERVER_HEALTH_PROBE_TIMEOUT_MS,
        agent: false,
      },
      response => {
        const chunks = []
        let total = 0
        response.on('data', chunk => {
          total += chunk.length
          if (total > SERVER_HEALTH_PROBE_MAX_BYTES) {
            response.destroy()
            finish({ reachable: false, agentRoom: false })
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          let agentRoom = false
          if (response.statusCode === 200) {
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              agentRoom = payload?.ok === true
                && (typeof payload?.version === 'string'
                  || typeof payload?.result?.version === 'string')
            } catch {
              agentRoom = false
            }
          }
          finish({ reachable: true, agentRoom })
        })
        response.on('aborted', () => finish({ reachable: false, agentRoom: false }))
        response.on('error', () => finish({ reachable: false, agentRoom: false }))
      },
    )
    overall = setTimeout(() => request.destroy(), SERVER_HEALTH_PROBE_TIMEOUT_MS)
    request.on('timeout', () => request.destroy())
    request.on('error', () => finish({ reachable: false, agentRoom: false }))
    request.end()
  })
}

// Stop a positively-identified daemon: SIGTERM, a bounded wait, then SIGKILL,
// then a bounded wait. Every escalation is poll-bounded; a daemon that
// survives the kill window fails the migration before the database is opened.
async function stopIdentifiedDaemon(pid) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if (error?.code === 'ESRCH') return
      fail('server_start_failed', `the recorded v0.1 daemon (pid ${pid}) could not be signalled: ${error?.code ?? 'unknown error'}`)
    }
    const giveUpAt = Date.now() + SERVER_CHILD_REAP_TIMEOUT_MS
    while (Date.now() < giveUpAt) {
      if (!pidAlive(pid)) return
      await delay(SERVER_ATTACH_POLL_MS)
    }
  }
  fail('server_start_failed', `the recorded v0.1 daemon (pid ${pid}) did not stop; the migration aborted before opening the database`)
}

// Absorb-or-stop (step 1). Only a process the record names AND whose /health
// answers like an agent-room server is ever signalled; everything else is
// left to the reclaim path or SQLite's own write serialization.
async function absorbOrStopLiveV1Daemon(dataDir) {
  let record
  try {
    record = readJsonFile(runtimeRecordPath(dataDir))
  } catch {
    return // absent, unreadable, or malformed: nothing to absorb
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return
  if (!Number.isInteger(record.pid) || record.pid <= 0) return
  if (!pidAlive(record.pid)) return // dead-and-unreachable: reclaimed by the boot

  const port = portFromRecord(record)
  if (port === null) {
    // A live pid with no probeable port cannot be identified; never signal.
    // The migration proceeds and the single-writer transaction arbitrates.
    return
  }

  // Bounded settle window: a daemon caught between spawn and listener start
  // gets one short chance to answer before classification.
  const settleDeadline = Date.now() + MIGRATION_DAEMON_SETTLE_MS
  let probe = await probeAgentRoomHealth(port)
  while (!probe.reachable && Date.now() < settleDeadline) {
    if (!pidAlive(record.pid)) return // died while settling: reclaimed
    await delay(SERVER_ATTACH_POLL_MS)
    probe = await probeAgentRoomHealth(port)
  }

  if (probe.agentRoom) {
    await stopIdentifiedDaemon(record.pid)
    return
  }
  if (probe.reachable) {
    // A foreign process holds the recorded port: it is never signalled, and
    // the migration refuses rather than boot past an unidentified holder
    // (the same rule ensure-server applies to attach).
    fail('server_port_conflict', 'the recorded server port is held by a process that is not agent-room; the migration refuses to proceed')
  }
  // Live pid, never answered: unidentifiable — proceed without signalling.
}

// Deterministic derived Actor fingerprint for a v1 actor id: `sha256:` over
// the UTF-8 bytes of the id. Distinct actor ids derive distinct fingerprints;
// the derivation is stable across migration reruns and crash resumes.
function derivedFingerprint(v1ActorId) {
  return FINGERPRINT_PREFIX + createHash('sha256').update(String(v1ActorId), 'utf8').digest('hex')
}

// Deterministic DR-1-grammar chat id for a v1 send-time display name:
// characters outside [A-Za-z0-9_.-] map to '_', truncated to CHAT_ID_MAX.
// The v1 display name CHECK guarantees at least one character, so the result
// is never empty; the fallback is defense against a hand-crafted file.
function derivedChatId(v1DisplayName) {
  const mapped = String(v1DisplayName).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, CHAT_ID_MAX)
  return mapped.length > 0 ? mapped : 'agent'
}

function assertV1Shape(database) {
  for (const table of V1_TABLES) {
    const row = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table)
    if (!row) {
      fail('database_schema_unsupported', `database claims schema version 1 but the ${table} table is missing`)
    }
  }
  const columns = database
    .prepare(`SELECT name FROM pragma_table_info('messages') ORDER BY cid`)
    .all()
    .map(row => row.name)
  if (
    columns.length !== V1_MESSAGE_COLUMNS.length
    || V1_MESSAGE_COLUMNS.some((name, index) => columns[index] !== name)
  ) {
    fail('database_schema_unsupported', 'database claims schema version 1 but messages has a divergent column set')
  }
}

// The single migration transaction (step 2): detect → re-sequence + remap →
// reshape → realm row → stamp v2. Every step is inside ONE BEGIN IMMEDIATE
// transaction, so a crash anywhere before COMMIT leaves the untouched v1 file
// for the next boot to migrate from scratch.
function migrateV1WithinTransaction(database) {
  return withImmediateTransaction(database, () => {
    // The authoritative detection happens inside the write transaction: a
    // concurrent boot may have completed the migration between our outer
    // probe and this lock. Its result is a no-op, never a second remap.
    const current = Number(pragmaValue(database, 'PRAGMA user_version'))
    if (current === ROOM_LOG_SCHEMA_VERSION) return null
    if (current !== 1) {
      fail(
        'database_schema_unsupported',
        `database schema ${current} is not supported; expected ${ROOM_LOG_SCHEMA_VERSION}`,
      )
    }
    assertV1Shape(database)

    // The v2 tables, built beside the v1 tables inside the same transaction.
    // rooms/messages collide with v1 names, so they are built as *_next and
    // swapped by rename; foreign keys are OFF for the whole rebuild (the
    // house rebuild recipe), and integrity is proven by PRAGMA
    // foreign_key_check before the commit.
    database.exec(`
      ${roomsTableDdl('rooms_next')}
      ${directMembersTableDdl()}
      ${chatIdClaimsTableDdl()}
      ${realmsTableDdl()}
      ${messagesTableDdl('messages_next')}
    `)

    // Rooms: every v0.1 room becomes a broadcast room with a NULL creator.
    // Ids, titles, and created_at are preserved verbatim (a v0.1 UUID room id
    // satisfies the v2 id CHECK).
    database.exec(`
      INSERT INTO rooms_next (id, kind, title, pair_key, created_by_fingerprint, created_at)
      SELECT id, 'broadcast', title, NULL, NULL, created_at
      FROM rooms;
    `)

    // Messages: per-room re-sequencing from 1 (arrival order, i.e. ascending
    // global seq) and the global→room-local reply_to_seq remap. The v1 schema
    // enforces (room_id, reply_to_seq) → messages(room_id, seq), so every
    // reply targets an earlier message of the same room and the ordered copy
    // always meets the target before the reply.
    const roomIds = database
      .prepare('SELECT id FROM rooms ORDER BY created_at ASC, id ASC')
      .all()
    const selectRoomMessages = database.prepare(`
      SELECT seq, actor_id, actor_display_name, client_message_id, text, reply_to_seq, created_at
      FROM messages
      WHERE room_id = ?
      ORDER BY seq ASC
    `)
    const insertMessage = database.prepare(`
      INSERT INTO messages_next (
        room_id, seq, actor_fingerprint, chat_id, client_message_id, text, reply_to_seq, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    let messageCount = 0
    try {
      for (const { id: roomId } of roomIds) {
        const remap = new Map()
        let nextSeq = 0
        for (const row of selectRoomMessages.all(roomId)) {
          nextSeq += 1
          const oldSeq = Number(row.seq)
          let replyToSeq = null
          if (row.reply_to_seq !== null && row.reply_to_seq !== undefined) {
            const mapped = remap.get(Number(row.reply_to_seq))
            if (mapped === undefined) {
              fail('database_schema_invalid', `a reply in room ${roomId} targets a message that is missing or not earlier in the v1 log`)
            }
            replyToSeq = mapped
          }
          insertMessage.run(
            roomId,
            nextSeq,
            derivedFingerprint(row.actor_id),
            derivedChatId(row.actor_display_name),
            String(row.client_message_id),
            String(row.text),
            replyToSeq,
            String(row.created_at),
          )
          remap.set(oldSeq, nextSeq)
          messageCount += 1
        }
      }
    } catch (error) {
      if (error instanceof AgentRoomRuntimeError) throw error
      // A v1 row that violates a v2 constraint (corrupt or foreign data)
      // fails the migration coded; the transaction rolls the file back to v1.
      fail('database_schema_invalid', `v1 data does not satisfy the v2 schema: ${error.message}`)
    }

    // The realm's first id is minted inside the transaction: crash-resume
    // simply re-runs from scratch, so only the COMMITTED mint ever exists.
    const realmId = randomUUID()
    database
      .prepare('INSERT INTO realms (singleton, realm_id, created_at) VALUES (1, ?, ?)')
      .run(realmId, new Date().toISOString())

    // Swap the colliding table names, drop the v1-only tables. Foreign keys
    // are OFF for the duration (set by the caller before this transaction).
    database.exec(`
      DROP TABLE messages;
      DROP TABLE room_members;
      DROP TABLE actors;
      DROP TABLE rooms;
      ALTER TABLE rooms_next RENAME TO rooms;
      ALTER TABLE messages_next RENAME TO messages;
    `)

    // Verify the reshaped schema BEFORE the stamp: foreign keys all resolve
    // (including messages' self-referential reply FK and the rooms FK the
    // renames rewrote), and every room's sequences are contiguous from 1.
    const violations = database.prepare('PRAGMA foreign_key_check').all()
    if (violations.length > 0) {
      fail('database_schema_invalid', `the migrated data violates foreign keys: ${JSON.stringify(violations)}`)
    }
    const fkTargets = [...new Set(database
      .prepare(`SELECT "table" AS target FROM pragma_foreign_key_list('messages')`)
      .all()
      .map(row => row.target))]
    // The reshaped log references exactly its rooms row and its own rows
    // (the two-column reply FK lists one pragma row per column, deduped here).
    if (fkTargets.sort().join(',') !== 'messages,rooms') {
      fail('database_schema_invalid', `the migrated messages table references unexpected tables: ${fkTargets.join(', ')}`)
    }
    const contiguity = database.prepare(`
      SELECT room_id, COUNT(*) AS count, MIN(seq) AS lowest, MAX(seq) AS highest
      FROM messages
      GROUP BY room_id
      HAVING lowest <> 1 OR highest <> count
    `).all()
    if (contiguity.length > 0) {
      fail('database_schema_invalid', `migrated sequences are not contiguous from 1: ${JSON.stringify(contiguity)}`)
    }

    // The stamp is transactional (part of the database header): a crash
    // before COMMIT rolls both the reshape and this stamp back together.
    database.exec(`PRAGMA user_version = ${ROOM_LOG_SCHEMA_VERSION};`)

    return { realmId, roomCount: roomIds.length, messageCount }
  })
}

// The store's open-path busy discipline, mirrored: the journal-mode switch is
// the first contended write, and the whole idempotent sequence retries with a
// small backoff under concurrent openers.
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function isBusyError(error) {
  return error?.errcode === SQLITE_BUSY
    || (error instanceof AgentRoomRuntimeError && error.code === 'database_busy')
}

function withBusyRetry(operation) {
  let attempt = 0
  for (;;) {
    try {
      return operation()
    } catch (error) {
      attempt += 1
      if (!isBusyError(error) || attempt > STORE_OPEN_BUSY_RETRY_LIMIT) throw error
      sleepSync(STORE_OPEN_BUSY_BACKOFF_MS * attempt)
    }
  }
}

// Entry point. Returns {migrated: true, realmId, roomCount, messageCount}
// when a v1 file was migrated in place, and {migrated: false} when the data
// dir holds no database or anything that is not a v1 file (fresh, current,
// future, foreign, or corrupt — those belong to openRoomLog's refusal paths).
export async function migrateV1InPlace({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim().length === 0) {
    fail('data_directory_invalid', 'dataDir must be a non-empty path')
  }

  const databasePath = join(dataDir, ROOM_LOG_DATABASE_FILENAME)

  // Probe-before-touch: absent, symlinked, or irregular files are not v1
  // databases — report not-migrated and let the store's own open path code
  // the outcome. The probe never modifies a file it refuses.
  let preexisting = false
  try {
    const info = lstatSync(databasePath)
    if (info.isSymbolicLink() || !info.isFile()) return { migrated: false }
    preexisting = true
  } catch (error) {
    if (error?.code === 'ENOENT') return { migrated: false }
    fail('data_directory_invalid', `agent-room database path is unusable: ${error.message}`)
  }
  if (!preexisting) return { migrated: false }

  let database
  try {
    try {
      database = new DatabaseSync(databasePath)
    } catch (error) {
      if (error?.errcode === SQLITE_NOTADB || error?.errcode === SQLITE_CORRUPT) {
        return { migrated: false }
      }
      throw error
    }
    database.exec('PRAGMA busy_timeout = 5000;')

    // Fast-path version probe. A pure read; on a foreign version the
    // connection closes without any write to the file.
    let probedVersion
    try {
      probedVersion = Number(pragmaValue(database, 'PRAGMA user_version'))
    } catch (error) {
      if (error?.errcode === SQLITE_NOTADB || error?.errcode === SQLITE_CORRUPT) {
        return { migrated: false }
      }
      throw error
    }
    if (probedVersion !== 1) return { migrated: false }

    // Step 1: absorb-or-stop before the database is touched by the migration.
    await absorbOrStopLiveV1Daemon(dataDir)

    // Step 2: configure, then run the one transaction. The v1 file is already
    // WAL (the v0.1 store enforced it); enforcing it again here is idempotent
    // and covers hand-crafted or older files. Foreign keys go OFF outside the
    // transaction (the pragma is a no-op inside one) for the rebuild, and are
    // restored and fully checked before the migration reports success.
    const migrated = withBusyRetry(() => {
      let journalMode
      try {
        journalMode = String(pragmaValue(database, 'PRAGMA journal_mode = WAL')).toLowerCase()
      } catch (error) {
        if (isBusyError(error)) {
          fail('database_busy', 'agent-room database stayed busy while enabling WAL journal mode')
        }
        throw error
      }
      if (journalMode !== 'wal') {
        fail('wal_unavailable', 'agent-room requires SQLite WAL journal mode')
      }
      database.exec(`
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
      `)
      database.exec('PRAGMA foreign_keys = OFF;')
      let outcome
      try {
        outcome = migrateV1WithinTransaction(database)
      } finally {
        try {
          database.exec('PRAGMA foreign_keys = ON;')
        } catch {
          // Preserve the migration error; the connection closes below.
        }
      }
      return outcome
    })

    if (migrated === null) return { migrated: false }

    chmodSync(databasePath, 0o600)
    for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600)
    }
    return { migrated: true, ...migrated }
  } finally {
    try {
      database?.close()
    } catch {
      // Preserve the migration outcome or error.
    }
  }
}
