// The per-realm allowlist and the client-side trust matrix (Story 3.2, FR-10,
// AD-12): the receiving installation decides, before a foreign message's body
// reaches a tool result, whether that sender delivers or is held.
//
// The decision is CLIENT-side by design. The server already enforces DM
// privacy (third-Actor denial) and stores the durable log for everyone; what
// this module owns is the plugin-local half of the trust matrix — what the
// RECEIVING agent's tool results show. Trust binds Actor key fingerprints
// (D13): Chat IDs and handles are display labels and are never an input to
// the matrix — a reused Chat ID or a replaced key inherits nothing.
//
// The matrix (priority order, FR-9/FR-10's default):
//   1. own Actor (sender fingerprint == this installation's fingerprint)
//        deliver — lane 'enforced': the comparison is plugin-verified code,
//        and it covers the same-Actor Direct Room, the flagship D14 path.
//   2. local transport (this installation's session authenticated through
//        the local token file path — Local Mode)
//        deliver — lane 'instructed': every sender on a loopback realm
//        crossed the same OS-user boundary, which is a human convention
//        (same-user processes are not cryptographically distinguishable),
//        so the lane is honestly labeled Instructed, never enforced.
//   3. the sender's fingerprint is an entry in this realm's allowlist
//        deliver — lane 'enforced': the human added the entry (one-step
//        release, Story 3.4's CLI), and the plugin verifies the sender's
//        fingerprint against the stored one.
//   4. accept-all is set for this realm (per-realm human opt-in, default
//      false, settable only through the human CLI — never an agent tool)
//        deliver — lane 'instructed': a blanket human opt-in with no
//        per-sender verification; the untrusted envelope framing always
//        remains on the delivered body.
//   5. anything else
//        HOLD — lane 'enforced': withholding the body is plugin-enforced
//        code (D17: omitting text is the Plugin-enforced lane). Every
//        remote sender without a verified basis is held — including one
//        whose Chat ID claims to be on the same machine, because a name is
//        not a basis and the matrix never reads one.
//
// A held message in this story is the minimal representation: body withheld,
// envelope metadata present (sender chat id and fingerprint ride the row and
// the marker text), and the matrix reason recorded. The full held pipeline —
// metadata-only surface, held cache, point-read recovery, release — is
// Story 3.3/3.4 and is deliberately not built here.
//
// Removal affects future delivery only: the matrix evaluates at delivery
// time, so text already ingested into an agent's context is never
// retroactively withdrawn and the durable log is never rewritten.
//
// Storage mirrors the cursor machinery exactly: one bounded, atomically
// rewritten 0600 JSON file per realm at
// PLUGIN_DATA/realms/<realm_id>/allowlist.json inside a 0700 realm
// directory. A missing or corrupt file is the default state (accept-all
// false, no entries) and never blocks a read.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { FINGERPRINT_PATTERN, REALM_KEY_PATTERN } from '../constants.mjs'
import { AgentRoomRuntimeError, atomicWriteJson, readJsonFile } from '../runtime.mjs'

// The two transports a receiving installation can have, from its own
// connection mode: 'local' — the session was authenticated through the local
// token file path (Local Mode); 'remote' — anything else (today the remote
// challenge path is Epic 4; the matrix fail-closes toward hold, so any
// transport that is not exactly 'local' is evaluated as remote). An
// installation whose host knows the session crosses the OS-user boundary may
// DECLARE the remote mode (api-client's AGENT_ROOM_CONNECTION_MODE seam,
// Story 3.5's chain proof, Epic 4's input) — the declaration is strictly
// fail-closed and outranks the local credential path.
export const LOCAL_TRANSPORT = 'local'
export const REMOTE_TRANSPORT = 'remote'

// The matrix verdicts. Reasons are stable snake_case labels recorded on held
// rows (held_reason) and reported by the trust tools' consumers; a reason is
// provenance for a decision, never a request field on the wire.
export const TRUST_REASONS = Object.freeze({
  ownActor: 'own_actor',
  localTransport: 'local_transport',
  allowlisted: 'allowlisted',
  acceptAll: 'accept_all',
  notAllowlisted: 'not_allowlisted',
})

// The default realm state: nothing trusted beyond the matrix's own-Actor and
// local-transport rows, and accept-all explicitly off. "Never a default" is
// the point — accept-all only ever appears because a human set it.
export function emptyAllowlist() {
  return Object.freeze({ version: 1, accept_all: false, entries: Object.freeze([]) })
}

// Normalize a stored or in-memory allowlist shape into the canonical state:
// accept_all is true only when stored exactly true, and entries keep only
// well-formed rows (a string fingerprint; optional string added_at/note).
// Malformed rows are dropped, never trusted — a hand-mangled file degrades to
// the default, and a garbage fingerprint entry is inert anyway (evaluation
// compares equality against real sender fingerprints).
function normalizeAllowlist(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyAllowlist()
  const rawEntries = Array.isArray(value.entries) ? value.entries : []
  const entries = []
  for (const entry of rawEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (typeof entry.fingerprint !== 'string' || entry.fingerprint.length === 0) continue
    entries.push({
      fingerprint: entry.fingerprint,
      ...(typeof entry.added_at === 'string' ? { added_at: entry.added_at } : {}),
      ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
    })
  }
  return Object.freeze({ version: 1, accept_all: value.accept_all === true, entries: Object.freeze(entries) })
}

// The pure trust matrix. `allowlist` is the realm state (as loadAllowlist
// returns); `transport` is the receiving installation's own connection mode
// (the api-client's transport getter — how ITS session authenticated). The
// sender's Chat ID is deliberately absent from the signature: names are
// labels, and no claim of locality or familiarity can move a decision (D13).
export function evaluateSender({
  senderFingerprint,
  ownFingerprint,
  transport,
  allowlist = emptyAllowlist(),
} = {}) {
  // 1. Own Actor: exact fingerprint equality, plugin-verified.
  if (
    typeof senderFingerprint === 'string'
    && typeof ownFingerprint === 'string'
    && senderFingerprint === ownFingerprint
  ) {
    return Object.freeze({ decision: 'deliver', lane: 'enforced', reason: TRUST_REASONS.ownActor })
  }
  // 2. Local transport: the OS-user boundary of a Local Mode realm. Instructed,
  //    never described as enforced.
  if (transport === LOCAL_TRANSPORT) {
    return Object.freeze({ decision: 'deliver', lane: 'instructed', reason: TRUST_REASONS.localTransport })
  }
  const state = normalizeAllowlist(allowlist)
  // 3. Allowlisted remote Actor: the stored entry binds this exact fingerprint.
  if (
    typeof senderFingerprint === 'string'
    && state.entries.some(entry => entry.fingerprint === senderFingerprint)
  ) {
    return Object.freeze({ decision: 'deliver', lane: 'enforced', reason: TRUST_REASONS.allowlisted })
  }
  // 4. Accept-all: the per-realm human opt-in. It delivers without any
  //    per-sender verification, so its lane is Instructed.
  if (state.accept_all === true) {
    return Object.freeze({ decision: 'deliver', lane: 'instructed', reason: TRUST_REASONS.acceptAll })
  }
  // 5. Everything else is held — including a sender with no fingerprint at
  //    all (fail-closed) and any sender whose Chat ID claims sameness.
  return Object.freeze({ decision: 'hold', lane: 'enforced', reason: TRUST_REASONS.notAllowlisted })
}

// The minimal held representation's marker text (Story 3.2): metadata and the
// recorded reason, and never a byte of the body. The chat id and fingerprint
// repeat the row's own metadata so the marker stays self-describing when the
// row is read in isolation; a non-string chat id becomes the deterministic
// "(unknown)" marker, mirroring the envelope's fail-closed handling. This
// text is plugin-authored — it is not foreign content and carries no
// untrusted envelope, because there is no foreign body to frame.
export function heldMessageText({ senderChatId, senderFingerprint, reason } = {}) {
  const chatId = typeof senderChatId === 'string' ? senderChatId : '(unknown)'
  const fingerprint = typeof senderFingerprint === 'string' ? senderFingerprint : '(unknown)'
  return [
    `[held] Message from chat id "${chatId}" (fingerprint ${fingerprint}) was not delivered: the sender is not trusted for this realm by this installation's trust matrix.`,
    'Body text is withheld — this marker carries metadata only, no message body.',
    `(reason: ${typeof reason === 'string' ? reason : 'unspecified'})`,
  ].join(' ')
}

// Delivery-time application of the matrix to one read page. Delivered rows
// pass through untouched (the untrusted envelope has already been applied by
// the api-client for foreign senders; this function neither unwraps nor
// re-wraps anything). Held rows keep every metadata field, have their text
// replaced by the held marker (the envelope-wrapped body never surfaces), and
// gain the additive `held` / `held_reason` fields. Non-page shapes pass
// through untouched, mirroring applyUntrustedEnvelope's discipline.
export function applyTrustMatrix(page, { ownFingerprint, transport, allowlist } = {}) {
  if (!page || typeof page !== 'object' || !Array.isArray(page.messages)) return page
  const messages = page.messages.map(message => {
    const verdict = evaluateSender({
      senderFingerprint: message && typeof message === 'object' ? message.actor_fingerprint : undefined,
      ownFingerprint,
      transport,
      allowlist,
    })
    if (verdict.decision === 'deliver') return message
    return {
      ...message,
      text: heldMessageText({
        senderChatId: message && typeof message === 'object' ? message.chat_id : undefined,
        senderFingerprint: message && typeof message === 'object' ? message.actor_fingerprint : undefined,
        reason: verdict.reason,
      }),
      held: true,
      held_reason: verdict.reason,
    }
  })
  return { ...page, messages }
}

// --- Storage (the cursor machinery's discipline, applied to the allowlist) ----

function assertRealmKey(realmId) {
  if (typeof realmId !== 'string' || !REALM_KEY_PATTERN.test(realmId)) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'the agent-room realm id is not a safe state key; refusing to build an allowlist path from it',
    )
  }
  return realmId
}

export function allowlistFilePath(pluginData, realmId) {
  return join(pluginData, 'realms', assertRealmKey(realmId), 'allowlist.json')
}

// Load one realm's state. A missing file is the default (accept-all false, no
// entries); a corrupt file degrades to the default and is overwritten by the
// next write — a broken state file never blocks a read, exactly like cursors.
export function loadAllowlist(pluginData, realmId) {
  const path = allowlistFilePath(pluginData, realmId)
  if (!existsSync(path)) return emptyAllowlist()
  try {
    return normalizeAllowlist(readJsonFile(path))
  } catch {
    return emptyAllowlist()
  }
}

// Add or remove one fingerprint entry. `allowed: true` is idempotent (a
// re-set keeps the original added_at — the trust grant's original moment —
// and only refreshes a provided note); `allowed: false` removes the entry if
// present and is a no-op otherwise. The write is atomic, 0600, inside the
// 0700 realm directory. Removal affects future delivery only — nothing else
// reads history here, and the durable log is never touched.
export function setAllowlistEntry(pluginData, realmId, fingerprint, allowed, { note } = {}) {
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'an allowlist entry binds a canonical Actor key fingerprint (sha256: plus 64 lowercase hex characters)',
    )
  }
  const loaded = loadAllowlist(pluginData, realmId)
  const state = { ...loaded, entries: [...loaded.entries] }
  const existing = state.entries.findIndex(entry => entry.fingerprint === fingerprint)
  if (allowed === true) {
    if (existing >= 0) {
      state.entries[existing] = {
        ...state.entries[existing],
        ...(note === undefined ? {} : { note }),
      }
    } else {
      state.entries.push({
        fingerprint,
        added_at: new Date().toISOString(),
        ...(note === undefined ? {} : { note }),
      })
    }
  } else {
    if (existing >= 0) state.entries.splice(existing, 1)
  }
  atomicWriteJson(allowlistFilePath(pluginData, realmId), {
    version: state.version,
    accept_all: state.accept_all,
    entries: state.entries,
  })
  return loadAllowlist(pluginData, realmId)
}

// The per-realm accept-all flag: a human opt-in stored beside the entries.
// Settable ONLY through the human CLI surface (Story 3.4) — no MCP tool
// exposes it, so an agent can never grant blanket delivery to a realm. The
// flag defaults to false everywhere: a missing file, a corrupt file, and a
// fresh realm all evaluate to hold for non-allowlisted remote senders.
export function setAcceptAll(pluginData, realmId, allowed) {
  const state = loadAllowlist(pluginData, realmId)
  atomicWriteJson(allowlistFilePath(pluginData, realmId), {
    version: state.version,
    accept_all: allowed === true,
    entries: state.entries,
  })
  return loadAllowlist(pluginData, realmId)
}
