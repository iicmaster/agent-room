import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'
import { join } from 'node:path'

import { KEYPAIR_FILE_MAX_BYTES } from './constants.mjs'
import {
  AgentRoomRuntimeError,
  ensurePrivateDirectory,
  regularPrivateFile,
} from './runtime.mjs'

export const KEYPAIR_FILENAME = 'identity.key'

function fail(message) {
  throw new AgentRoomRuntimeError('identity_key_invalid', message)
}

// Canonical Actor fingerprint: `sha256:` plus lowercase hex SHA-256 over the
// raw 32-byte Ed25519 public key — never over the SPKI-DER encoding. Only a
// Buffer or Uint8Array of exactly 32 bytes is accepted; anything else is a
// coded identity_key_invalid error, never an uncoded TypeError.
export function fingerprintFromPublicKey(rawPublicKey) {
  if (!(rawPublicKey instanceof Uint8Array) || rawPublicKey.length !== 32) {
    fail('agent-room fingerprint requires the raw 32-byte Ed25519 public key as a Buffer or Uint8Array')
  }
  const bytes = Buffer.isBuffer(rawPublicKey) ? rawPublicKey : Buffer.from(rawPublicKey)
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function rawPublicKeyFrom(privateKey) {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('agent-room identity key must be an Ed25519 private key')
  }
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  if (spki.length < 32) {
    fail('agent-room identity key SPKI DER is too short to contain a raw Ed25519 public key')
  }
  // Raw Ed25519 public key is the trailing 32 bytes of the SPKI DER encoding.
  return spki.subarray(-32)
}

// TOCTOU-safe read: lstat validation first, then an O_NOFOLLOW open whose
// descriptor is fstat-re-verified, so a path swapped to a symlink or an
// oversized/non-regular file can never be followed or trusted.
//
// O_NOFOLLOW is REQUIRED, not optional. Coercing a missing flag to 0 would
// silently open the symlink the check exists to refuse, on exactly the
// platforms where the guarantee is least visible. Where the platform cannot
// enforce it, this refuses rather than reading a key file it cannot trust.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

function readPrivateKeyPem(path) {
  try {
    regularPrivateFile(path, KEYPAIR_FILE_MAX_BYTES)
  } catch (error) {
    fail(`agent-room identity key file is unusable: ${error.message}`)
  }
  if (NOFOLLOW === 0) {
    fail('agent-room cannot enforce O_NOFOLLOW on this platform; refusing to read an identity key file it cannot verify')
  }
  let descriptor
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | NOFOLLOW)
  } catch (error) {
    fail(`agent-room identity key file is unreadable: ${error.message}`)
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size < 1 || info.size > KEYPAIR_FILE_MAX_BYTES) {
      fail('agent-room identity key file is not a bounded regular file')
    }
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    if (offset !== bytes.length) {
      fail('agent-room identity key file changed while reading')
    }
    // Re-tighten the mode through the descriptor in case it loosened.
    fchmodSync(descriptor, 0o600)
    return bytes.toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

// Atomic publish: the key material is fully written (looping writeSync), then
// fsynced to a private 0600 temporary file, then linked into place. Readers
// only ever see the complete file, a concurrent starter can never be clobbered
// (the link is exclusive), and on ANY error the temporary file is removed and
// the error rethrown — a partial final file can never exist.
function publishKeypairFile(path, pem) {
  const temporary = `${path}.${randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    const bytes = Buffer.from(pem, 'utf8')
    let offset = 0
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
    }
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(temporary, 0o600)
    try {
      linkSync(temporary, path)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // Another starter published the keypair first; read theirs below.
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch { /* linked or never created */ }
  }
}

function readKeypair(path) {
  const pem = readPrivateKeyPem(path)
  let privateKey
  try {
    privateKey = createPrivateKey(pem)
  } catch {
    fail('agent-room identity key file is not valid private key material')
  }
  const rawPublicKey = rawPublicKeyFrom(privateKey)
  return Object.freeze({
    fingerprint: fingerprintFromPublicKey(rawPublicKey),
    publicKey: Buffer.from(rawPublicKey),
    path,
  })
}

// Load the installation keypair or create it once. An existing key file is
// never overwritten or regenerated: invalid, oversized, or symlinked files
// refuse to start so the Actor identity can never change silently. The
// returned object never contains private key bytes.
export function loadOrCreateKeypair(pluginDataDir) {
  const directory = ensurePrivateDirectory(pluginDataDir)
  const path = join(directory, KEYPAIR_FILENAME)
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    publishKeypairFile(path, pem)
    // Whether this process published the file or lost the race, the file on
    // disk is the single authoritative keypair for the installation.
  }
  return readKeypair(path)
}

// The fixed 12-byte SPKI DER prefix of an Ed25519 SubjectPublicKeyInfo —
// the exact bytes rawPublicKeyFrom strips when it takes the trailing 32
// bytes. Prepending it to a raw key rebuilds the same DER encoding, which is
// the whole construction of verifyWithRawPublicKey below.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

// Sign a payload with the installation's own keypair (Story 4.1's remote
// challenge path). The private PEM is read INSIDE this module, the signing
// happens INSIDE this module, and the only thing that leaves is the 64-byte
// signature: no return value, log line, wire body, or tool result ever
// carries key material (FR-3's first consequence). The keypair is
// load-or-created like every other consumer, so a first sign on a fresh
// installation births the identity exactly once.
export function signWithInstallationKey(pluginDataDir, data) {
  if (!(data instanceof Uint8Array) || data.length === 0) {
    fail('agent-room signing requires a non-empty payload as a Buffer or Uint8Array')
  }
  loadOrCreateKeypair(pluginDataDir)
  const pem = readPrivateKeyPem(join(ensurePrivateDirectory(pluginDataDir), KEYPAIR_FILENAME))
  let privateKey
  try {
    privateKey = createPrivateKey(pem)
  } catch {
    fail('agent-room identity key file is not valid private key material')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('agent-room identity key must be an Ed25519 private key')
  }
  return cryptoSign(null, Buffer.from(data), privateKey)
}

// Verify an Ed25519 signature against a RAW 32-byte public key — the exact
// inverse of rawPublicKeyFrom: the raw bytes are wrapped back into their SPKI
// DER encoding and handed to crypto.verify. Any malformed input — wrong key
// length, wrong signature length, undecodable DER — is `false`, never a
// throw: the challenge-answer route maps false to its coded rejection
// without an internal-fault detour.
export function verifyWithRawPublicKey(rawPublicKey, data, signature) {
  try {
    if (!(rawPublicKey instanceof Uint8Array) || rawPublicKey.length !== 32) return false
    if (!(data instanceof Uint8Array) || data.length === 0) return false
    if (!(signature instanceof Uint8Array) || signature.length !== 64) return false
    const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPublicKey)])
    const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' })
    return cryptoVerify(null, Buffer.from(data), publicKey, Buffer.from(signature))
  } catch {
    return false
  }
}
