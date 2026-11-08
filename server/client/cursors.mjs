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

// Map roomId -> after_seq for one realm. Only safe, non-negative integers
// surface; every other stored shape is ignored, never repaired.
export function loadPersistedCursors(pluginDataDir, realmId) {
  const path = persistedCursorPath(pluginDataDir, realmId)
  const cursors = new Map()
  if (!existsSync(path)) return cursors
  let stored = {}
  try {
    const value = readJsonFile(path)
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
