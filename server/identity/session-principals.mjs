// Identity context: durable session principals — the server-issued per-process
// session identity beneath an installation key (v0.9.0 session addressing).
//
// This module owns the SQL/query semantics for the session_principals table
// while the storage composition root (`server/store/room-log.mjs`) remains
// sole owner of DB open/close, pragmas, schema bootstrap/migrations and
// validation functions — the exact split claims.mjs established. Operations
// receive only the already-open DatabaseSync and the existing BEGIN IMMEDIATE
// runner; they never create a connection or own a schema version.
//
// Normative model (spec session-principals.md / session-protocol.md):
//   - A session principal is {session_id, generation} issued by the server
//     after the installation authenticates, plus a full address
//     `base~token@machine` (a public locator, never a credential) and a
//     256-bit capability whose SHA-256 DIGEST is the only server-side trace.
//   - Two independent lifetimes: the base lease (45 s since the last valid
//     heartbeat) is liveness bookkeeping only — its expiry never deletes the
//     principal, the address, pair-room membership or the mailbox — and
//     principal retention (30 days after the last heartbeat, or until an
//     operator revoke).
//   - Base-name occupancy is NOT exclusive in this implementation: two live
//     principals may share one base+machine, each under its own random
//     locator token (DUP_BASE_SAME_INSTALL answers both; `chat_id_taken`
//     never arises from this case). Only the FULL ADDRESS is unique among
//     retained principals — a collision is a coded `name_taken` refusal, and
//     the loser is never suffixed, merged, or displaced.
//   - An old generation is fenced: after a resume bumps the generation, the
//     previous generation's beats answer `session_expired` and can renew or
//     displace nothing.
//   - The raw capability is returned exactly once at allocation; every
//     projection below omits the digest, and no operation ever logs or
//     re-emits credential material.

import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { AgentRoomRuntimeError } from '../runtime.mjs'
import {
  SESSION_ADDRESS_MAX_CHARS,
  SESSION_BASE_LEASE_MS,
  SESSION_LOCATOR_TOKEN_CHARS,
  SESSION_MACHINE_MAX,
  SESSION_MACHINE_PATTERN,
  SESSION_PRINCIPAL_RETENTION_MS,
  CHAT_ID_MAX,
} from '../constants.mjs'

// The canonical principal projection. capability_digest is deliberately
// absent — the digest never leaves the store layer, and no caller (route,
// listing, receipt) ever sees credential material.
const PRINCIPAL_COLUMNS = `
  session_id,
  installation_fingerprint,
  generation,
  base_name,
  address,
  machine,
  client_type,
  created_at,
  last_heartbeat_at,
  base_lease_expires_at,
  base_lease_status,
  principal_retention_expires_at,
  principal_status
`

function plainPrincipal(row) {
  return {
    session_id: row.session_id,
    installation_fingerprint: row.installation_fingerprint,
    generation: Number(row.generation),
    base_name: row.base_name,
    address: row.address,
    machine: row.machine,
    client_type: row.client_type === null ? null : String(row.client_type),
    created_at: row.created_at,
    last_heartbeat_at: row.last_heartbeat_at,
    base_lease_expires_at: row.base_lease_expires_at,
    base_lease_status: row.base_lease_status,
    principal_retention_expires_at: row.principal_retention_expires_at,
    principal_status: row.principal_status,
  }
}

// The session_principals DDL (additive, IF NOT EXISTS on every open — the
// invites/claims convergence pattern, no schema-version bump). STRICT, with
// the retained-address uniqueness enforced by the partial unique index below
// rather than the table: revoked and retention-expired principals free their
// address. The table's DDL is exported for the store's open-path convergence
// and its verification, exactly like invitesTableDdl.
export function sessionPrincipalsTableDdl({ ifNotExists = false } = {}) {
  return `
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}session_principals (
      session_id TEXT PRIMARY KEY,
      installation_fingerprint TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      base_name TEXT NOT NULL,
      address TEXT NOT NULL,
      machine TEXT NOT NULL,
      client_type TEXT,
      capability_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      base_lease_expires_at TEXT NOT NULL,
      base_lease_status TEXT NOT NULL CHECK (base_lease_status IN ('occupied','expired','released')),
      principal_retention_expires_at TEXT NOT NULL,
      principal_status TEXT NOT NULL CHECK (principal_status IN ('retained','revoked','retention_expired')),
      CHECK (length(base_name) BETWEEN 1 AND ${CHAT_ID_MAX}),
      CHECK (length(address) BETWEEN 1 AND ${SESSION_ADDRESS_MAX_CHARS}),
      CHECK (length(machine) BETWEEN 1 AND ${SESSION_MACHINE_MAX}),
      CHECK (address GLOB '*~*@*'),
      CHECK (length(client_type) IS NULL OR length(client_type) BETWEEN 1 AND 32),
      CHECK (length(capability_digest) = 64 AND capability_digest NOT GLOB '*[^0-9a-f]*')
    ) STRICT;
  `
}

export const SESSION_PRINCIPALS_COLUMNS = Object.freeze([
  'session_id',
  'installation_fingerprint',
  'generation',
  'base_name',
  'address',
  'machine',
  'client_type',
  'capability_digest',
  'created_at',
  'last_heartbeat_at',
  'base_lease_expires_at',
  'base_lease_status',
  'principal_retention_expires_at',
  'principal_status',
])

export const SESSION_PRINCIPALS_ADDRESS_INDEX_NAME = 'idx_session_principals_address'
export const SESSION_PRINCIPALS_LIVE_BASE_INDEX_NAME = 'idx_session_principals_live_base'

// Full-address uniqueness among RETAINED principals (the address of a revoked
// or retention-expired principal is freed). IF NOT EXISTS on every open; the
// store's open path verifies the index name and column set afterwards.
export function sessionPrincipalsAddressIndexDdl() {
  return `
    CREATE UNIQUE INDEX IF NOT EXISTS ${SESSION_PRINCIPALS_ADDRESS_INDEX_NAME}
      ON session_principals (address)
      WHERE principal_status = 'retained';
  `
}

// Live Agent ID (lower(base_name)) uniqueness across retained principals with
// an occupied base lease (Story 1.2).
export function sessionPrincipalsLiveBaseIndexDdl() {
  return `
    CREATE UNIQUE INDEX IF NOT EXISTS ${SESSION_PRINCIPALS_LIVE_BASE_INDEX_NAME}
      ON session_principals (lower(base_name))
      WHERE principal_status = 'retained' AND base_lease_status = 'occupied';
  `
}

export function createSessionPrincipalOperations({ database, withImmediateTransaction, validate }) {
  const { assertOpen, fail, requireObject, requireFingerprint, requireChatId } = validate

  const machineForm = value => {
    if (typeof value !== 'string' || !SESSION_MACHINE_PATTERN.test(value)) {
      fail('invalid_request', `machine must be 1-${SESSION_MACHINE_MAX} characters starting with a letter or number, using letters, numbers, dot, underscore, or hyphen`)
    }
    return value
  }

  const capabilityDigestOf = capability => createHash('sha256').update(capability, 'utf8').digest('hex')

  // The lazy retention sweep, run inside the write paths' transactions: a
  // retained principal past its retention expiry flips to retention_expired
  // and its base lease is released — the address frees (the partial unique
  // index only spans retained rows) while the row and its mailbox stay for
  // the room log's own retention policy.
  const sweepRetention = nowMs => {
    const cutoff = new Date(nowMs).toISOString()
    database.prepare(`
      UPDATE session_principals
      SET principal_status = 'retention_expired', base_lease_status = 'released'
      WHERE principal_status = 'retained' AND principal_retention_expires_at < ?
    `).run(cutoff)
  }

  const sweepBaseLeasesImpl = nowMs => {
    const cutoff = new Date(nowMs).toISOString()
    database.prepare(`
      UPDATE session_principals
      SET base_lease_status = 'expired'
      WHERE principal_status = 'retained' AND base_lease_status = 'occupied' AND base_lease_expires_at <= ?
    `).run(cutoff)
  }

  const selectBySessionId = sessionId => database
    .prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM session_principals WHERE session_id = ?`)
    .get(sessionId)

  const selectRetainedByAddress = address => database
    .prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM session_principals WHERE address = ? AND principal_status = 'retained'`)
    .get(address)

  const selectOccupiedByBase = baseName => database
    .prepare(`
      SELECT ${PRINCIPAL_COLUMNS}
      FROM session_principals
      WHERE principal_status = 'retained' AND base_lease_status = 'occupied' AND lower(base_name) = lower(?)
      LIMIT 1
    `)
    .get(baseName)

  const failAgentIdTaken = (baseName, holder) => {
    const error = new AgentRoomRuntimeError(
      'agent_id_taken',
      `Agent ID "${baseName}" is currently occupied by another live session`,
    )
    if (holder) {
      error.conflictHolder = plainPrincipal(holder)
    }
    throw error
  }

  const requireRetainedLive = (row, { allowRevokedCode = null } = {}) => {
    if (!row) fail('session_expired', 'no retained session principal matches this credential')
    if (row.principal_status === 'revoked') {
      fail(allowRevokedCode ?? 'session_revoked', 'session principal was revoked by the operator')
    }
    if (row.principal_status !== 'retained') {
      fail('session_expired', 'session principal retention has expired')
    }
    return row
  }

  function prepareAllocateArgs(options) {
    const {
      installationFingerprint,
      baseName,
      machine,
      clientType = null,
      nowMs,
      locatorTokenFn = () => randomBytes(7).toString('base64url').slice(0, SESSION_LOCATOR_TOKEN_CHARS),
      capabilityBytesFn = () => randomBytes(32),
    } = requireObject(options)
    const validFingerprint = requireFingerprint(installationFingerprint)
    const validBase = requireChatId(baseName)
    const validMachine = machineForm(machine)
    const now = requireNow(nowMs)
    const validClientType = clientType === null || clientType === undefined
      ? null
      : (typeof clientType === 'string' && clientType.length >= 1 && clientType.length <= 32
        ? clientType
        : fail('invalid_request', 'clientType must be a string of 1-32 characters when provided'))
    const capability = capabilityBytesFn()
    if (!Buffer.isBuffer(capability) || capability.length !== 32) {
      fail('invalid_argument', 'capabilityBytesFn must answer a 32-byte Buffer')
    }
    const capabilityDigest = capabilityDigestOf(capability.toString('base64url'))
    return {
      validFingerprint,
      validBase,
      validMachine,
      validClientType,
      now,
      locatorTokenFn,
      capability,
      capabilityDigest,
    }
  }

  function allocateSessionPrincipalInTxImpl({
    validFingerprint,
    validBase,
    validMachine,
    validClientType,
    now,
    locatorTokenFn,
    capability,
    capabilityDigest,
  }) {
    const createdAt = new Date(now).toISOString()
    const leaseExpiresAt = new Date(now + SESSION_BASE_LEASE_MS).toISOString()
    const retentionExpiresAt = new Date(now + SESSION_PRINCIPAL_RETENTION_MS).toISOString()
    sweepRetention(now)
    sweepBaseLeasesImpl(now)
    const baseHolder = selectOccupiedByBase(validBase)
    if (baseHolder) {
      failAgentIdTaken(validBase, baseHolder)
    }
    const address = `${validBase}~${locatorTokenFn()}@${validMachine}`
    const holder = selectRetainedByAddress(address)
    if (holder) {
      // Explicit duplicate live address: refuse with the holder's machine,
      // never suffix, never merge, never take the base from a live holder.
      fail('name_taken', `session address ${address} is already held by a live principal on machine ${holder.machine}`)
    }
    const sessionId = randomUUID()
    try {
      database.prepare(`
        INSERT INTO session_principals (
          session_id, installation_fingerprint, generation, base_name, address, machine,
          client_type, capability_digest, created_at, last_heartbeat_at, base_lease_expires_at,
          base_lease_status, principal_retention_expires_at, principal_status
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'occupied', ?, 'retained')
      `).run(
        sessionId, validFingerprint, validBase, address, validMachine,
        validClientType, capabilityDigest, createdAt, createdAt, leaseExpiresAt, retentionExpiresAt,
      )
    } catch (error) {
      const conflictingBase = selectOccupiedByBase(validBase)
      if (conflictingBase) {
        failAgentIdTaken(validBase, conflictingBase)
      }
      const conflictingAddress = selectRetainedByAddress(address)
      if (conflictingAddress) {
        fail('name_taken', `session address ${address} is already held by a live principal on machine ${conflictingAddress.machine}`)
      }
      throw error
    }
    const row = selectBySessionId(sessionId)
    return { ...plainPrincipal(row), session_capability: capability.toString('base64url') }
  }

  function heartbeatSessionPrincipalInTxImpl({ sessionId, generation, now, onReoccupy }) {
    sweepRetention(now)
    sweepBaseLeasesImpl(now)
    const row = selectBySessionId(sessionId)
    requireRetainedLive(row)
    if (Number(row.generation) !== generation) {
      fail('session_expired', `session generation ${generation} is fenced; the current generation is ${Number(row.generation)}`)
    }
    if (row.base_lease_status !== 'occupied') {
      const existingHolder = selectOccupiedByBase(row.base_name)
      if (existingHolder && existingHolder.session_id !== row.session_id) {
        failAgentIdTaken(row.base_name, existingHolder)
      }
      onReoccupy?.(plainPrincipal(row))
    }
    const beatAt = new Date(now).toISOString()
    const leaseExpiresAt = new Date(now + SESSION_BASE_LEASE_MS).toISOString()
    const retentionExpiresAt = new Date(now + SESSION_PRINCIPAL_RETENTION_MS).toISOString()
    try {
      database.prepare(`
        UPDATE session_principals
        SET last_heartbeat_at = ?, base_lease_expires_at = ?, base_lease_status = 'occupied',
            principal_retention_expires_at = ?
        WHERE session_id = ?
      `).run(beatAt, leaseExpiresAt, retentionExpiresAt, sessionId)
    } catch (error) {
      const existingHolder = selectOccupiedByBase(row.base_name)
      if (existingHolder && existingHolder.session_id !== row.session_id) {
        failAgentIdTaken(row.base_name, existingHolder)
      }
      throw error
    }
    return plainPrincipal(selectBySessionId(sessionId))
  }

  function resumeSessionPrincipalInTxImpl({ sessionId, generation, now, onReoccupy }) {
    sweepRetention(now)
    sweepBaseLeasesImpl(now)
    const row = selectBySessionId(sessionId)
    requireRetainedLive(row)
    if (Number(row.generation) !== generation) {
      fail('session_expired', `session generation ${generation} is fenced; the current generation is ${Number(row.generation)}`)
    }
    const existingHolder = selectOccupiedByBase(row.base_name)
    if (existingHolder && existingHolder.session_id !== row.session_id) {
      failAgentIdTaken(row.base_name, existingHolder)
    }
    onReoccupy?.(plainPrincipal(row))
    const beatAt = new Date(now).toISOString()
    const leaseExpiresAt = new Date(now + SESSION_BASE_LEASE_MS).toISOString()
    const retentionExpiresAt = new Date(now + SESSION_PRINCIPAL_RETENTION_MS).toISOString()
    try {
      database.prepare(`
        UPDATE session_principals
        SET generation = generation + 1, last_heartbeat_at = ?,
            base_lease_expires_at = ?, base_lease_status = 'occupied',
            principal_retention_expires_at = ?
        WHERE session_id = ?
      `).run(beatAt, leaseExpiresAt, retentionExpiresAt, sessionId)
    } catch (error) {
      const holderAfter = selectOccupiedByBase(row.base_name)
      if (holderAfter && holderAfter.session_id !== row.session_id) {
        failAgentIdTaken(row.base_name, holderAfter)
      }
      throw error
    }
    return plainPrincipal(selectBySessionId(sessionId))
  }

  function releaseSessionBaseLeaseInTxImpl(sessionId) {
    const row = selectBySessionId(sessionId)
    if (!row) fail('session_expired', 'no session principal matches this credential')
    database.prepare(`
      UPDATE session_principals SET base_lease_status = 'released' WHERE session_id = ?
    `).run(sessionId)
    return plainPrincipal(selectBySessionId(sessionId))
  }

  return Object.freeze({
    sweepBaseLeasesInTx(nowMs) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'sweepBaseLeasesInTx requires an active transaction')
      }
      sweepBaseLeasesImpl(requireNow(nowMs))
    },

    findOccupiedBaseOwner(baseName, nowMs) {
      assertOpen()
      const validBase = requireChatId(baseName)
      const cutoff = new Date(requireNow(nowMs)).toISOString()
      const row = database.prepare(`
        SELECT ${PRINCIPAL_COLUMNS}
        FROM session_principals
        WHERE principal_status = 'retained'
          AND base_lease_status = 'occupied'
          AND lower(base_name) = lower(?)
          AND base_lease_expires_at > ?
        LIMIT 1
      `).get(validBase, cutoff)
      return row ? plainPrincipal(row) : null
    },

    allocateSessionPrincipalInTx(options) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'allocateSessionPrincipalInTx requires an active transaction')
      }
      const prepared = prepareAllocateArgs(options)
      return allocateSessionPrincipalInTxImpl(prepared)
    },

    // Allocate one session principal under an authenticated installation.
    allocateSessionPrincipal(options) {
      assertOpen()
      const prepared = prepareAllocateArgs(options)
      return withImmediateTransaction(database, () => allocateSessionPrincipalInTxImpl(prepared))
    },

    // Heartbeat: authenticated callers resolved the capability digest first
    // (findSessionPrincipalByCapabilityDigest); the body's session_id and
    // generation are SELECTORS checked against the digest's row here. A
    // fenced generation, a revoked or retention-expired principal, or an
    // unknown session answers coded refusals and mutates nothing. A valid
    // beat renews ONLY this principal's lease.
    heartbeatSessionPrincipalInTx(options) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'heartbeatSessionPrincipalInTx requires an active transaction')
      }
      const { sessionId, generation, nowMs, onReoccupy } = requireObject(options)
      const now = requireNow(nowMs)
      return heartbeatSessionPrincipalInTxImpl({ sessionId, generation, now, onReoccupy })
    },

    heartbeatSessionPrincipal(options) {
      assertOpen()
      const { sessionId, generation, nowMs, onReoccupy } = requireObject(options)
      const now = requireNow(nowMs)
      return withImmediateTransaction(database, () =>
        heartbeatSessionPrincipalInTxImpl({ sessionId, generation, now, onReoccupy }),
      )
    },

    resumeSessionPrincipalInTx(options) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'resumeSessionPrincipalInTx requires an active transaction')
      }
      const { sessionId, generation, nowMs, onReoccupy } = requireObject(options)
      const now = requireNow(nowMs)
      return resumeSessionPrincipalInTxImpl({ sessionId, generation, now, onReoccupy })
    },

    // Resume an offline-but-retained principal: the capability's generation
    // must still be current. Success INCREMENTS the generation (fencing every
    // older beat), refreshes the base lease, and returns the SAME session id
    // and full address.
    resumeSessionPrincipal(options) {
      assertOpen()
      const { sessionId, generation, nowMs, onReoccupy } = requireObject(options)
      const now = requireNow(nowMs)
      return withImmediateTransaction(database, () =>
        resumeSessionPrincipalInTxImpl({ sessionId, generation, now, onReoccupy }),
      )
    },

    releaseSessionBaseLeaseInTx(options) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'releaseSessionBaseLeaseInTx requires an active transaction')
      }
      const { sessionId } = requireObject(options)
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        fail('invalid_argument', 'sessionId must be a non-empty string')
      }
      return releaseSessionBaseLeaseInTxImpl(sessionId)
    },

    // Release the base lease only: the durable principal, full address,
    // pair-room membership and mailbox all persist. Duplicate release is an
    // idempotent success.
    releaseSessionBaseLease(options) {
      assertOpen()
      const { sessionId } = requireObject(options)
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        fail('invalid_argument', 'sessionId must be a non-empty string')
      }
      return withImmediateTransaction(database, () => releaseSessionBaseLeaseInTxImpl(sessionId))
    },

    // Operator revoke (installation-authenticated callers): the principal
    // must belong to the caller's installation. Marks the principal revoked,
    // frees its base lease, and ends retention — future capability use
    // answers session_revoked. Room-log messages are never deleted.
    // Idempotent: revoking an already-revoked principal succeeds. A session
    // id that belongs to another installation (or no session at all) is a
    // zero-state refusal that reveals nothing.
    revokeSessionPrincipal(options) {
      assertOpen()
      const { sessionId, installationFingerprint } = requireObject(options)
      const validFingerprint = requireFingerprint(installationFingerprint)
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        fail('invalid_argument', 'sessionId must be a non-empty string')
      }
      return withImmediateTransaction(database, () => {
        const row = selectBySessionId(sessionId)
        if (!row || row.installation_fingerprint !== validFingerprint) {
          fail('unauthorized', 'this session principal does not belong to this installation')
        }
        database.prepare(`
          UPDATE session_principals
          SET principal_status = 'revoked', base_lease_status = 'released'
          WHERE session_id = ?
        `).run(sessionId)
        return plainPrincipal(selectBySessionId(sessionId))
      })
    },

    // The capability lookup the session-scheme verifier runs: digest → the
    // one principal it was minted for (any status — callers classify revoked
    // vs expired). The presented raw capability never touches this table;
    // callers hash it first.
    findSessionPrincipalByCapabilityDigest(capabilityDigest) {
      assertOpen()
      if (typeof capabilityDigest !== 'string' || capabilityDigest.length !== 64) {
        fail('invalid_argument', 'capabilityDigest must be the 64-hex-character SHA-256 digest of a presented capability')
      }
      const row = database
        .prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM session_principals WHERE capability_digest = ?`)
        .get(capabilityDigest)
      return row ? plainPrincipal(row) : null
    },

    // Addressed-send resolution: only a RETAINED principal resolves. The
    // constant `peer_not_found` refusal is the caller's; this read never
    // enumerates anything.
    resolveSessionPrincipalByAddress(address) {
      assertOpen()
      if (typeof address !== 'string' || address.length === 0) {
        fail('invalid_argument', 'address must be a non-empty string')
      }
      const row = selectRetainedByAddress(address)
      return row ? plainPrincipal(row) : null
    },

    // The capability-principal liveness read for the long-poll's per-wake
    // re-check (the session-pair read's analogue of the ban re-check): one
    // indexed primary-key lookup answering {principal_status, generation} —
    // revoked / retention-expired / fenced mid-hold, the hold answers coded
    // refusals on its next wake. Read-only.
    getSessionPrincipalStatus(sessionId) {
      assertOpen()
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        fail('invalid_argument', 'sessionId must be a non-empty string')
      }
      const row = database
        .prepare(`SELECT principal_status, generation, principal_retention_expires_at FROM session_principals WHERE session_id = ?`)
        .get(sessionId)
      return row
        ? {
            principal_status: row.principal_status,
            generation: Number(row.generation),
            principal_retention_expires_at: row.principal_retention_expires_at,
          }
        : null
    },

    // The explicit listing (CAP-3: enumeration is a separate command, never
    // piggybacked on a refusal). Runs the retention sweep first, then every
    // principal in deterministic created-then-id order with its computed
    // presence: online iff its own base lease is occupied and unexpired.
    listSessionPrincipals(options = {}) {
      assertOpen()
      const { nowMs } = requireObject(options)
      const now = requireNow(nowMs)
      const cutoff = new Date(now).toISOString()
      const hasRetentionExpired = database.prepare(`
        SELECT 1
        FROM session_principals
        WHERE principal_status = 'retained' AND principal_retention_expires_at < ?
        LIMIT 1
      `).get(cutoff)
      const readRows = () => database
        .prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM session_principals ORDER BY created_at ASC, session_id ASC`)
        .all()
      const rows = hasRetentionExpired
        ? withImmediateTransaction(database, () => {
            sweepRetention(now)
            return readRows()
          })
        : readRows()
      return rows.map(row => {
        const principal = plainPrincipal(row)
        const leaseLive = principal.base_lease_status === 'occupied'
          && Date.parse(principal.base_lease_expires_at) > now
        return { ...principal, presence: leaseLive ? 'online' : 'offline' }
      })
    },
  })
}

function requireNow(nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'nowMs must be a positive epoch-millisecond integer')
  }
  return now
}
