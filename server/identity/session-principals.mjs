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

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import { AgentRoomRuntimeError } from '../runtime.mjs'
import {
  CONFLICT_TICKET_TTL_MS,
  SESSION_ADDRESS_MAX_CHARS,
  SESSION_BASE_LEASE_MS,
  SESSION_LOCATOR_TOKEN_CHARS,
  SESSION_MACHINE_MAX,
  SESSION_MACHINE_PATTERN,
  SESSION_PRINCIPAL_RETENTION_MS,
  SESSION_RECOVERY_ID_PATTERN,
  SESSION_REVOKE_REASON_MAX,
  CHAT_ID_MAX,
} from '../constants.mjs'

// The canonical principal projection. capability_digest, prev_capability_digest,
// and recovery_id_digest are deliberately absent — digests never leave the
// store layer, and no caller (route, listing, receipt) ever sees credential
// material.
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
  principal_status,
  revoked_reason
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
    revoked_reason: row.revoked_reason === null || row.revoked_reason === undefined ? null : String(row.revoked_reason),
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
      prev_capability_digest TEXT,
      rotated_at TEXT,
      recovery_id_digest TEXT,
      revoked_reason TEXT,
      CHECK (length(base_name) BETWEEN 1 AND ${CHAT_ID_MAX}),
      CHECK (length(address) BETWEEN 1 AND ${SESSION_ADDRESS_MAX_CHARS}),
      CHECK (length(machine) BETWEEN 1 AND ${SESSION_MACHINE_MAX}),
      CHECK (address GLOB '*~*@*'),
      CHECK (length(client_type) IS NULL OR length(client_type) BETWEEN 1 AND 32),
      CHECK (length(capability_digest) = 64 AND capability_digest NOT GLOB '*[^0-9a-f]*'),
      CHECK (prev_capability_digest IS NULL OR (length(prev_capability_digest) = 64 AND prev_capability_digest NOT GLOB '*[^0-9a-f]*')),
      CHECK (recovery_id_digest IS NULL OR (length(recovery_id_digest) = 64 AND recovery_id_digest NOT GLOB '*[^0-9a-f]*')),
      CHECK (revoked_reason IS NULL OR length(revoked_reason) <= ${SESSION_REVOKE_REASON_MAX})
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
  'prev_capability_digest',
  'rotated_at',
  'recovery_id_digest',
  'revoked_reason',
])

export const SESSION_PRINCIPALS_TAIL_ADD_DDL = Object.freeze([
  ['prev_capability_digest', 'ALTER TABLE session_principals ADD COLUMN prev_capability_digest TEXT;'],
  ['rotated_at', 'ALTER TABLE session_principals ADD COLUMN rotated_at TEXT;'],
  ['recovery_id_digest', 'ALTER TABLE session_principals ADD COLUMN recovery_id_digest TEXT;'],
  ['revoked_reason', 'ALTER TABLE session_principals ADD COLUMN revoked_reason TEXT;'],
])

export const SESSION_PRINCIPALS_ADDRESS_INDEX_NAME = 'idx_session_principals_address'
export const SESSION_PRINCIPALS_LIVE_BASE_INDEX_NAME = 'idx_session_principals_live_base'
export const SESSION_PRINCIPALS_CAPABILITY_INDEX_NAME = 'idx_session_principals_capability'
export const SESSION_PRINCIPALS_PREV_CAPABILITY_INDEX_NAME = 'idx_session_principals_prev_capability'

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

export function sessionPrincipalsCapabilityIndexDdl() {
  return `
    CREATE UNIQUE INDEX IF NOT EXISTS ${SESSION_PRINCIPALS_CAPABILITY_INDEX_NAME}
      ON session_principals (capability_digest);
  `
}

export function sessionPrincipalsPrevCapabilityIndexDdl() {
  return `
    CREATE UNIQUE INDEX IF NOT EXISTS ${SESSION_PRINCIPALS_PREV_CAPABILITY_INDEX_NAME}
      ON session_principals (prev_capability_digest)
      WHERE prev_capability_digest IS NOT NULL;
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
      WHERE principal_status = 'retained' AND principal_retention_expires_at <= ?
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

  const selectRetainedByAddress = (address, nowMs = undefined) => {
    if (nowMs !== undefined) {
      const cutoff = new Date(requireNow(nowMs)).toISOString()
      return database
        .prepare(`
          SELECT ${PRINCIPAL_COLUMNS}
          FROM session_principals
          WHERE address = ?
            AND principal_status = 'retained'
            AND principal_retention_expires_at > ?
        `)
        .get(address, cutoff)
    }
    return database
      .prepare(`
        SELECT ${PRINCIPAL_COLUMNS}
        FROM session_principals
        WHERE address = ?
          AND principal_status = 'retained'
      `)
      .get(address)
  }

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
      recoveryId = null,
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
    const validRecoveryId = validateOptionalRecoveryId(recoveryId)
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
      validRecoveryId,
      now,
      locatorTokenFn,
      capability,
      capabilityDigest,
    }
  }

  function validateOptionalRecoveryId(recoveryId) {
    if (recoveryId === null || recoveryId === undefined) return null
    if (typeof recoveryId !== 'string' || !SESSION_RECOVERY_ID_PATTERN.test(recoveryId)) {
      fail('invalid_request', 'recovery_id must be 22-64 URL-safe base64 characters')
    }
    return recoveryId
  }

  function mintCapability(capabilityBytesFn = () => randomBytes(32)) {
    const capability = capabilityBytesFn()
    if (!Buffer.isBuffer(capability) || capability.length !== 32) {
      fail('invalid_argument', 'capabilityBytesFn must answer a 32-byte Buffer')
    }
    const raw = capability.toString('base64url')
    return { raw, digest: capabilityDigestOf(raw) }
  }

  function digestsEqualHex(aHex, bHex) {
    if (typeof aHex !== 'string' || typeof bHex !== 'string' || aHex.length !== 64 || bHex.length !== 64) {
      return false
    }
    return timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'))
  }

  function withinRecoveryWindow(rotatedAtIso, now) {
    if (typeof rotatedAtIso !== 'string') return false
    const rotatedAtMs = Date.parse(rotatedAtIso)
    if (!Number.isFinite(rotatedAtMs)) return false
    const elapsed = now - rotatedAtMs
    return elapsed >= 0 && elapsed <= CONFLICT_TICKET_TTL_MS
  }

  function allocateSessionPrincipalInTxImpl({
    validFingerprint,
    validBase,
    validMachine,
    validClientType,
    validRecoveryId,
    now,
    locatorTokenFn,
    capability,
    capabilityDigest,
  }) {
    const createdAt = new Date(now).toISOString()
    const leaseExpiresAt = new Date(now + SESSION_BASE_LEASE_MS).toISOString()
    const retentionExpiresAt = new Date(now + SESSION_PRINCIPAL_RETENTION_MS).toISOString()
    const recoveryDigest = validRecoveryId ? capabilityDigestOf(validRecoveryId) : null
    const rotatedAt = validRecoveryId ? createdAt : null
    sweepRetention(now)
    sweepBaseLeasesImpl(now)
    const baseHolder = selectOccupiedByBase(validBase)
    if (baseHolder) {
      failAgentIdTaken(validBase, baseHolder)
    }
    const address = `${validBase}~${locatorTokenFn()}@${validMachine}`
    const holder = selectRetainedByAddress(address, now)
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
          base_lease_status, principal_retention_expires_at, principal_status,
          rotated_at, recovery_id_digest
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'occupied', ?, 'retained', ?, ?)
      `).run(
        sessionId, validFingerprint, validBase, address, validMachine,
        validClientType, capabilityDigest, createdAt, createdAt, leaseExpiresAt, retentionExpiresAt,
        rotatedAt, recoveryDigest,
      )
    } catch (error) {
      const conflictingBase = selectOccupiedByBase(validBase)
      if (conflictingBase) {
        failAgentIdTaken(validBase, conflictingBase)
      }
      const conflictingAddress = selectRetainedByAddress(address, now)
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

  function resumeSessionPrincipalInTxImpl({
    sessionId,
    generation,
    now,
    recoveryId = null,
    presentedPrevDigest = null,
    onReoccupy,
    capabilityBytesFn,
  }) {
    sweepRetention(now)
    sweepBaseLeasesImpl(now)
    const row = database.prepare(`
      SELECT ${PRINCIPAL_COLUMNS}, capability_digest, prev_capability_digest, rotated_at, recovery_id_digest
      FROM session_principals
      WHERE session_id = ?
    `).get(sessionId)
    requireRetainedLive(row)

    const validRecoveryId = validateOptionalRecoveryId(recoveryId)
    const isRecoveryRetry = presentedPrevDigest !== null
    if (isRecoveryRetry) {
      if (!validRecoveryId) {
        fail('session_credential_invalid', 'recovery_id is required to recover a rotated session capability')
      }
      if (
        row.prev_capability_digest !== presentedPrevDigest
        || !withinRecoveryWindow(row.rotated_at, now)
        || !digestsEqualHex(capabilityDigestOf(validRecoveryId), row.recovery_id_digest)
      ) {
        fail('session_credential_invalid', 'session capability recovery window expired or recovery_id did not match')
      }
      if (generation > Number(row.generation)) {
        fail('session_expired', `session generation ${generation} is fenced; the current generation is ${Number(row.generation)}`)
      }
    } else if (Number(row.generation) !== generation) {
      fail('session_expired', `session generation ${generation} is fenced; the current generation is ${Number(row.generation)}`)
    }

    const existingHolder = selectOccupiedByBase(row.base_name)
    if (existingHolder && existingHolder.session_id !== row.session_id) {
      failAgentIdTaken(row.base_name, existingHolder)
    }
    onReoccupy?.(plainPrincipal(row))

    const { raw: nextCapability, digest: nextDigest } = mintCapability(capabilityBytesFn)
    const beatAt = new Date(now).toISOString()
    const leaseExpiresAt = new Date(now + SESSION_BASE_LEASE_MS).toISOString()
    const retentionExpiresAt = new Date(now + SESSION_PRINCIPAL_RETENTION_MS).toISOString()

    try {
      if (isRecoveryRetry) {
        // Keep the original prev_capability_digest, rotated_at (t0), and
        // recovery_id_digest unextended across repeated lost-response retries.
        database.prepare(`
          UPDATE session_principals
          SET generation = generation + 1, capability_digest = ?,
              last_heartbeat_at = ?, base_lease_expires_at = ?,
              base_lease_status = 'occupied', principal_retention_expires_at = ?
          WHERE session_id = ?
        `).run(nextDigest, beatAt, leaseExpiresAt, retentionExpiresAt, sessionId)
      } else {
        const recoveryDigest = validRecoveryId ? capabilityDigestOf(validRecoveryId) : null
        database.prepare(`
          UPDATE session_principals
          SET generation = generation + 1, capability_digest = ?,
              prev_capability_digest = ?, rotated_at = ?, recovery_id_digest = ?,
              last_heartbeat_at = ?, base_lease_expires_at = ?,
              base_lease_status = 'occupied', principal_retention_expires_at = ?
          WHERE session_id = ?
        `).run(
          nextDigest, row.capability_digest, beatAt, recoveryDigest,
          beatAt, leaseExpiresAt, retentionExpiresAt, sessionId,
        )
      }
    } catch (error) {
      const holderAfter = selectOccupiedByBase(row.base_name)
      if (holderAfter && holderAfter.session_id !== row.session_id) {
        failAgentIdTaken(row.base_name, holderAfter)
      }
      throw error
    }
    return { ...plainPrincipal(selectBySessionId(sessionId)), session_capability: nextCapability }
  }

  function takeoverSessionPrincipalInTxImpl({
    sessionId,
    expectedGeneration,
    now,
    recoveryId = null,
    capabilityBytesFn,
  }) {
    sweepRetention(now)
    sweepBaseLeasesImpl(now)
    const row = database.prepare(`
      SELECT ${PRINCIPAL_COLUMNS}, capability_digest
      FROM session_principals
      WHERE session_id = ?
    `).get(sessionId)
    if (!row || row.principal_status !== 'retained' || Number(row.generation) !== expectedGeneration) {
      fail('conflict_stale', 'the observed incumbent session principal is no longer at the observed generation')
    }
    const validRecoveryId = validateOptionalRecoveryId(recoveryId)
    const recoveryDigest = validRecoveryId ? capabilityDigestOf(validRecoveryId) : null
    const { raw: nextCapability, digest: nextDigest } = mintCapability(capabilityBytesFn)
    const beatAt = new Date(now).toISOString()
    const leaseExpiresAt = new Date(now + SESSION_BASE_LEASE_MS).toISOString()
    const retentionExpiresAt = new Date(now + SESSION_PRINCIPAL_RETENTION_MS).toISOString()
    database.prepare(`
      UPDATE session_principals
      SET generation = generation + 1, capability_digest = ?,
          prev_capability_digest = ?, rotated_at = ?, recovery_id_digest = ?,
          last_heartbeat_at = ?, base_lease_expires_at = ?,
          base_lease_status = 'occupied', principal_retention_expires_at = ?
      WHERE session_id = ?
    `).run(
      nextDigest, row.capability_digest, beatAt, recoveryDigest,
      beatAt, leaseExpiresAt, retentionExpiresAt, sessionId,
    )
    return { ...plainPrincipal(selectBySessionId(sessionId)), session_capability: nextCapability, replaced: true }
  }

  function retryTakeoverByRecoveryInTxImpl({
    installationFingerprint,
    baseName,
    recoveryId,
    now,
    capabilityBytesFn,
  }) {
    const validRecoveryId = validateOptionalRecoveryId(recoveryId)
    if (!validRecoveryId) return null
    sweepRetention(now)
    sweepBaseLeasesImpl(now)
    const recoveryDigest = capabilityDigestOf(validRecoveryId)
    const row = database.prepare(`
      SELECT ${PRINCIPAL_COLUMNS}, rotated_at
      FROM session_principals
      WHERE installation_fingerprint = ?
        AND lower(base_name) = lower(?)
        AND recovery_id_digest = ?
        AND principal_status = 'retained'
      LIMIT 1
    `).get(installationFingerprint, baseName, recoveryDigest)
    if (!row || row.base_lease_status !== 'occupied' || !withinRecoveryWindow(row.rotated_at, now)) {
      return null
    }
    const { raw: nextCapability, digest: nextDigest } = mintCapability(capabilityBytesFn)
    const beatAt = new Date(now).toISOString()
    const leaseExpiresAt = new Date(now + SESSION_BASE_LEASE_MS).toISOString()
    const retentionExpiresAt = new Date(now + SESSION_PRINCIPAL_RETENTION_MS).toISOString()
    database.prepare(`
      UPDATE session_principals
      SET generation = generation + 1, capability_digest = ?,
          last_heartbeat_at = ?, base_lease_expires_at = ?,
          base_lease_status = 'occupied', principal_retention_expires_at = ?
      WHERE session_id = ?
    `).run(nextDigest, beatAt, leaseExpiresAt, retentionExpiresAt, row.session_id)
    return { ...plainPrincipal(selectBySessionId(row.session_id)), session_capability: nextCapability, replaced: true }
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
      const { sessionId, generation, nowMs, recoveryId, presentedPrevDigest, onReoccupy, capabilityBytesFn } = requireObject(options)
      const now = requireNow(nowMs)
      return resumeSessionPrincipalInTxImpl({
        sessionId,
        generation,
        now,
        recoveryId,
        presentedPrevDigest,
        onReoccupy,
        capabilityBytesFn,
      })
    },

    // Resume an offline-but-retained principal: the capability's generation
    // must still be current. Success INCREMENTS the generation (fencing every
    // older beat), rotates capability_digest, refreshes the base lease, and
    // returns the SAME session id and full address.
    resumeSessionPrincipal(options) {
      assertOpen()
      const { sessionId, generation, nowMs, recoveryId, presentedPrevDigest, onReoccupy, capabilityBytesFn } = requireObject(options)
      const now = requireNow(nowMs)
      return withImmediateTransaction(database, () =>
        resumeSessionPrincipalInTxImpl({
          sessionId,
          generation,
          now,
          recoveryId,
          presentedPrevDigest,
          onReoccupy,
          capabilityBytesFn,
        }),
      )
    },

    takeoverSessionPrincipalInTx(options) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'takeoverSessionPrincipalInTx requires an active transaction')
      }
      const { sessionId, expectedGeneration, nowMs, recoveryId, capabilityBytesFn } = requireObject(options)
      const now = requireNow(nowMs)
      return takeoverSessionPrincipalInTxImpl({
        sessionId,
        expectedGeneration,
        now,
        recoveryId,
        capabilityBytesFn,
      })
    },

    retryTakeoverByRecoveryInTx(options) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'retryTakeoverByRecoveryInTx requires an active transaction')
      }
      const { installationFingerprint, baseName, recoveryId, nowMs, capabilityBytesFn } = requireObject(options)
      const validFingerprint = requireFingerprint(installationFingerprint)
      const validBase = requireChatId(baseName)
      const now = requireNow(nowMs)
      return retryTakeoverByRecoveryInTxImpl({
        installationFingerprint: validFingerprint,
        baseName: validBase,
        recoveryId,
        now,
        capabilityBytesFn,
      })
    },

    clearPrincipalRecoveryInTx(options) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'clearPrincipalRecoveryInTx requires an active transaction')
      }
      const { sessionId, capabilityDigest } = requireObject(options)
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        fail('invalid_argument', 'sessionId must be a non-empty string')
      }
      if (typeof capabilityDigest !== 'string' || capabilityDigest.length !== 64) {
        fail('invalid_argument', 'capabilityDigest must be 64 hex characters')
      }
      const result = database.prepare(`
        UPDATE session_principals
        SET prev_capability_digest = NULL, rotated_at = NULL, recovery_id_digest = NULL
        WHERE session_id = ? AND capability_digest = ? AND prev_capability_digest IS NOT NULL
      `).run(sessionId, capabilityDigest)
      return Number(result.changes ?? 0)
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
    revokeSessionPrincipalInTx(options) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'revokeSessionPrincipalInTx requires an active transaction')
      }
      const { sessionId, installationFingerprint, reason = null } = requireObject(options)
      const validFingerprint = requireFingerprint(installationFingerprint)
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        fail('invalid_argument', 'sessionId must be a non-empty string')
      }
      const validReason = reason === null || reason === undefined
        ? null
        : (typeof reason === 'string' && reason.length <= SESSION_REVOKE_REASON_MAX
          ? reason
          : fail('invalid_request', `reason must be a string of at most ${SESSION_REVOKE_REASON_MAX} characters`))
      const row = selectBySessionId(sessionId)
      if (!row || row.installation_fingerprint !== validFingerprint) {
        fail('unauthorized', 'this session principal does not belong to this installation')
      }
      database.prepare(`
        UPDATE session_principals
        SET principal_status = 'revoked', base_lease_status = 'released',
            revoked_reason = COALESCE(?, revoked_reason),
            prev_capability_digest = NULL, rotated_at = NULL, recovery_id_digest = NULL
        WHERE session_id = ?
      `).run(validReason, sessionId)
      return plainPrincipal(selectBySessionId(sessionId))
    },

    revokeSessionPrincipal(options) {
      assertOpen()
      const { sessionId, installationFingerprint, reason = null } = requireObject(options)
      const validFingerprint = requireFingerprint(installationFingerprint)
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        fail('invalid_argument', 'sessionId must be a non-empty string')
      }
      const validReason = reason === null || reason === undefined
        ? null
        : (typeof reason === 'string' && reason.length <= SESSION_REVOKE_REASON_MAX
          ? reason
          : fail('invalid_request', `reason must be a string of at most ${SESSION_REVOKE_REASON_MAX} characters`))
      return withImmediateTransaction(database, () => {
        const row = selectBySessionId(sessionId)
        if (!row || row.installation_fingerprint !== validFingerprint) {
          fail('unauthorized', 'this session principal does not belong to this installation')
        }
        database.prepare(`
          UPDATE session_principals
          SET principal_status = 'revoked', base_lease_status = 'released',
              revoked_reason = COALESCE(?, revoked_reason),
              prev_capability_digest = NULL, rotated_at = NULL, recovery_id_digest = NULL
          WHERE session_id = ?
        `).run(validReason, sessionId)
        return plainPrincipal(selectBySessionId(sessionId))
      })
    },

    // Host-local operator revoke (AD-13): matches by session_id or full
    // address without an installation check, keeps capability_digest intact so
    // future requests answer canonical 401 session_revoked, and clears any
    // transitional recovery columns. Returns null when no principal matches.
    revokeSessionPrincipalByHost(options) {
      assertOpen()
      const { target, reason = null } = requireObject(options)
      if (typeof target !== 'string' || target.length === 0) {
        fail('invalid_argument', 'target must be a non-empty session_id or session_address')
      }
      const validReason = reason === null || reason === undefined
        ? null
        : (typeof reason === 'string' && reason.length <= SESSION_REVOKE_REASON_MAX
          ? reason
          : fail('invalid_request', `reason must be a string of at most ${SESSION_REVOKE_REASON_MAX} characters`))
      return withImmediateTransaction(database, () => {
        const row = database.prepare(`
          SELECT ${PRINCIPAL_COLUMNS}
          FROM session_principals
          WHERE (session_id = ? OR address = ?) AND principal_status = 'retained'
          LIMIT 1
        `).get(target, target)
        if (!row) return null
        database.prepare(`
          UPDATE session_principals
          SET principal_status = 'revoked', base_lease_status = 'released',
              revoked_reason = ?,
              prev_capability_digest = NULL, rotated_at = NULL, recovery_id_digest = NULL
          WHERE session_id = ?
        `).run(validReason, row.session_id)
        return plainPrincipal(selectBySessionId(row.session_id))
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

    // Recovery-window lookup: accepted ONLY on POST /api/session-principals/resume.
    findSessionPrincipalByPrevCapabilityDigest(prevCapabilityDigest) {
      assertOpen()
      if (typeof prevCapabilityDigest !== 'string' || prevCapabilityDigest.length !== 64) {
        fail('invalid_argument', 'prevCapabilityDigest must be the 64-hex-character SHA-256 digest')
      }
      const row = database
        .prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM session_principals WHERE prev_capability_digest = ?`)
        .get(prevCapabilityDigest)
      return row ? plainPrincipal(row) : null
    },

    // Addressed-send resolution: only a RETAINED, non-expired principal
    // resolves. The constant `peer_not_found` refusal is the caller's; this
    // read never enumerates anything.
    resolveSessionPrincipalByAddress(address, nowMs = undefined) {
      assertOpen()
      if (typeof address !== 'string' || address.length === 0) {
        fail('invalid_argument', 'address must be a non-empty string')
      }
      const row = selectRetainedByAddress(address, nowMs)
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
        .prepare(`SELECT principal_status, generation, principal_retention_expires_at, (prev_capability_digest IS NOT NULL) AS has_pending_recovery FROM session_principals WHERE session_id = ?`)
        .get(sessionId)
      return row
        ? {
            principal_status: row.principal_status,
            generation: Number(row.generation),
            principal_retention_expires_at: row.principal_retention_expires_at,
            has_pending_recovery: Boolean(row.has_pending_recovery),
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
        WHERE principal_status = 'retained' AND principal_retention_expires_at <= ?
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
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now <= 0 || now >= 253402300800000) {
    throw new AgentRoomRuntimeError('invalid_argument', 'nowMs must be a positive epoch-millisecond integer')
  }
  return now
}
