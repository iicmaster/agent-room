// The local bootstrap credential (Story 1.4, spine AD-5): a long-lived token
// file in the shared data dir (0600, bounded regular non-symlink file) that
// POST /api/auth/local exchanges for a session token. Local Mode's trust
// boundary is the OS user, so the file lives beside runtime.json in the
// shared data dir — never in PLUGIN_DATA.
//
// Creation discipline: the file is created on first need by the CLIENT side
// of the local path (ensureServer guarantees it after every boot/attach, and
// loadOrCreateLocalToken is the client's loader). The HTTP path is strictly
// read-only — readLocalToken never creates, never rewrites: a missing or
// unusable file is a 401 local_token_invalid credential failure with zero
// state change. Every accepted read re-tightens the mode to 0600 through the
// open descriptor (O_NOFOLLOW), so a loosened file self-heals on use while a
// symlinked or oversized file is refused.

import { chmodSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { LOCAL_TOKEN_MAX_BYTES } from '../constants.mjs'
import { AgentRoomRuntimeError, ensurePrivateDirectory } from '../runtime.mjs'

export const LOCAL_TOKEN_FILENAME = 'local-token'

export function localTokenPath(sharedDataDir) {
  return join(sharedDataDir, LOCAL_TOKEN_FILENAME)
}

// One bounded, descriptor-validated read. Every failure mode — missing,
// unreadable, symlinked, oversized, mid-read change, malformed content — is a
// coded local_token_invalid credential failure (401 on the wire).
function readTokenFile(path) {
  let descriptor
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new AgentRoomRuntimeError('local_token_invalid', 'agent-room local token file is missing')
    }
    throw new AgentRoomRuntimeError('local_token_invalid', 'agent-room local token file is unreadable')
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size < 1 || info.size > LOCAL_TOKEN_MAX_BYTES) {
      throw new AgentRoomRuntimeError('local_token_invalid', 'agent-room local token file is not a bounded regular file')
    }
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    if (offset !== bytes.length) {
      throw new AgentRoomRuntimeError('local_token_invalid', 'agent-room local token file changed while reading')
    }
    const token = bytes.toString('utf8').trim()
    // Generated tokens are 32 random bytes → 43 base64url characters; the
    // bounds accept the generated shape plus headroom for operator-provisioned
    // credentials of the same alphabet.
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      throw new AgentRoomRuntimeError('local_token_invalid', 'agent-room local token is invalid')
    }
    // Accepted read: re-tighten the mode through the descriptor.
    fchmodSync(descriptor, 0o600)
    return token
  } finally {
    closeSync(descriptor)
  }
}

// Read-only loader for the HTTP path: never creates, never writes.
export function readLocalToken(sharedDataDir) {
  return readTokenFile(localTokenPath(sharedDataDir))
}

// Client-side loader: load the shared local token or create it once at 0600.
// A racing creator loses the exclusive create and reads the winner's file, so
// every caller converges on the same credential. An existing file is never
// rewritten or regenerated.
export function loadOrCreateLocalToken(sharedDataDir) {
  if (typeof sharedDataDir !== 'string' || sharedDataDir.trim().length === 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'loadOrCreateLocalToken requires a data directory')
  }
  const directory = ensurePrivateDirectory(sharedDataDir)
  const path = localTokenPath(directory)
  if (existsSync(path)) return readTokenFile(path)

  let descriptor
  try {
    descriptor = openSync(path, 'wx', 0o600)
    writeSync(descriptor, `${randomBytes(32).toString('base64url')}\n`)
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(path, 0o600)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (error?.code !== 'EEXIST') throw error
  }
  return readTokenFile(path)
}
