// The client-owned cursor file, READ-ONLY side. The MCP adapter
// (server/mcp-stdio.mjs) owns the file, the monotonic advance and the
// per-realm serialization; this module is the shared reader for the surfaces
// that must know the adapter's fetched position without ever advancing it —
// the `agent-room wait` baselines and the notifier's startup catch-up. A
// missing or unusable file means "no cursor yet"; a corrupt file never blocks
// a reader (it reads as empty, exactly as the writer treats it).
//
// Client context: the file lives under PLUGIN_DATA (installation-local
// state), keyed per realm id with the same safe-key shape every realm path
// in this tree uses.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { REALM_KEY_PATTERN } from '../constants.mjs'
import { AgentRoomRuntimeError, readJsonFile } from '../runtime.mjs'
import { sessionScopeKey } from './session-state.mjs'

// The same path-escape guard the writer applies: the realm id keys
// directories under PLUGIN_DATA, so its shape is verified before any path is
// built from it.
export function assertRealmKey(realmId) {
  if (typeof realmId !== 'string' || !REALM_KEY_PATTERN.test(realmId)) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'the agent-room realm id is not a safe cursor key; refusing to build a cursor path from it',
    )
  }
  return realmId
}

export function persistedCursorPath(pluginDataDir, realmId) {
  return join(pluginDataDir, 'realms', assertRealmKey(realmId), 'cursors.json')
}

// The v0.9.0 per-session cursor file for THIS process: the path is built
// from the same scope key the MCP adapter chose for its session credential,
// so a reader in-process (the notifier's catch-up) reads exactly the
// position the writer advances.
export function sessionCursorPath(pluginDataDir, { env = process.env } = {}) {
  const scope = sessionScopeKey({ env })
  return join(pluginDataDir, 'sessions', assertRealmKey(scope), 'cursors.json')
}

// Map roomId -> after_seq for one realm. Only safe, non-negative integers
// surface; every other stored shape is ignored, never repaired.
//
// v0.9.0 namespace resolution: the per-session cursor file
// (sessions/<scope>/cursors.json — the file THIS process's MCP adapter
// writes) is preferred; the legacy realms/<realm>/cursors.json is the
// fallback (a fresh v0.9 installation seeds from it). The scope derives from
// the same env discipline the adapter used to pick its credential file, so
// the reader and the writer agree without any timing dependency. A session
// document that records a DIFFERENT realm is not this realm's position and
// is skipped like a missing file.
export function loadPersistedCursors(pluginDataDir, realmId, { env = process.env } = {}) {
  const sessionPath = sessionCursorPath(pluginDataDir, { env })
  // The first file that EXISTS wins: the session namespace is THIS process's
  // position (an existing-but-empty file means this session has consumed
  // nothing — baseline 0, never a legacy resurrection); the legacy file is
  // only its seed.
  for (const path of [sessionPath, persistedCursorPath(pluginDataDir, realmId)]) {
    if (!existsSync(path)) continue
    const cursors = new Map()
    let stored = {}
    try {
      const value = readJsonFile(path)
      if (path === sessionPath
        && value && typeof value === 'object'
        && value.realm_id !== undefined && value.realm_id !== realmId) {
        continue
      }
      stored = value && typeof value === 'object' && value.cursors && typeof value.cursors === 'object'
        ? value.cursors
        : {}
    } catch {
      return cursors
    }
    for (const [roomId, entry] of Object.entries(stored)) {
      const afterSeq = entry?.after_seq
      if (typeof afterSeq === 'number' && Number.isSafeInteger(afterSeq) && afterSeq >= 0) {
        cursors.set(roomId, afterSeq)
      }
    }
    return cursors
  }
  return new Map()
}
