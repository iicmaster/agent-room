import assert from 'node:assert/strict'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { KEYPAIR_FILE_MAX_BYTES } from '../server/constants.mjs'
import { fingerprintFromPublicKey, loadOrCreateKeypair } from '../server/keys.mjs'

const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/
const KEYS_MODULE = fileURLToPath(new URL('../server/keys.mjs', import.meta.url))

test('a fresh installation creates one bounded 0600 regular key file and a canonical fingerprint', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-room-keys-fresh-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const keyPath = join(directory, 'identity.key')

  const keypair = loadOrCreateKeypair(directory)

  assert.equal(keypair.path, keyPath)
  assert.match(keypair.fingerprint, FINGERPRINT_PATTERN)
  assert.equal(keypair.publicKey.length, 32)
  assert.equal(keypair.privateKey, undefined, 'private key bytes are never returned')
  assert.doesNotMatch(JSON.stringify(keypair), /PRIVATE KEY/)

  const info = lstatSync(keyPath)
  assert.equal(info.isSymbolicLink(), false)
  assert.equal(info.isFile(), true)
  assert.ok(info.size > 0 && info.size <= KEYPAIR_FILE_MAX_BYTES, 'key file must stay size-bounded')
  assert.equal(info.mode & 0o777, 0o600)
  assert.equal(lstatSync(directory).mode & 0o777, 0o700)

  // The fingerprint covers exactly the raw trailing 32 bytes of the SPKI DER
  // public key — never the whole SPKI-DER encoding.
  const pem = readFileSync(keyPath, 'utf8')
  const spki = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(-32)
  assert.equal(keypair.fingerprint, `sha256:${createHash('sha256').update(raw).digest('hex')}`)
  assert.notEqual(
    keypair.fingerprint,
    `sha256:${createHash('sha256').update(spki).digest('hex')}`,
    'fingerprint must not hash the SPKI-DER bytes',
  )
  assert.deepEqual(keypair.publicKey, raw)
})

test('reloading keeps the identical fingerprint, leaves the file untouched, and re-tightens the mode', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-room-keys-reload-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const first = loadOrCreateKeypair(directory)
  const before = readFileSync(first.path)

  chmodSync(first.path, 0o644)
  const second = loadOrCreateKeypair(directory)

  assert.equal(second.fingerprint, first.fingerprint)
  assert.deepEqual(readFileSync(first.path), before)
  assert.equal(lstatSync(first.path).mode & 0o777, 0o600)
})

test('invalid key material refuses to start and is never overwritten or regenerated', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-room-keys-invalid-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const keyPath = join(directory, 'identity.key')
  writeFileSync(keyPath, 'definitely not private key material\n', { mode: 0o600 })

  assert.throws(
    () => loadOrCreateKeypair(directory),
    error => error.code === 'identity_key_invalid' && /identity key/.test(error.message),
  )
  assert.equal(readFileSync(keyPath, 'utf8'), 'definitely not private key material\n')
})

test('non-Ed25519 key material is refused', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-room-keys-rsa-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keyPath = join(directory, 'identity.key')
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

  assert.throws(
    () => loadOrCreateKeypair(directory),
    error => error.code === 'identity_key_invalid' && /Ed25519/.test(error.message),
  )
})

test('oversized key files are refused without reading them into memory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-room-keys-large-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const keyPath = join(directory, 'identity.key')
  writeFileSync(keyPath, Buffer.alloc(KEYPAIR_FILE_MAX_BYTES + 1, 0x61), { mode: 0o600 })

  assert.throws(
    () => loadOrCreateKeypair(directory),
    error => error.code === 'identity_key_invalid',
  )
  assert.equal(lstatSync(keyPath).size, KEYPAIR_FILE_MAX_BYTES + 1)
})

test('symlinked key files are refused and the target is never followed or replaced', { skip: process.platform === 'win32' }, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-room-keys-symlink-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const target = join(parent, 'real-key')
  writeFileSync(target, 'untouched target\n', { mode: 0o600 })
  const directory = join(parent, 'data')
  mkdirSync(directory, { mode: 0o700 })
  symlinkSync(target, join(directory, 'identity.key'))

  assert.throws(
    () => loadOrCreateKeypair(directory),
    error => error.code === 'identity_key_invalid' && /identity key/.test(error.message),
  )
  assert.equal(readFileSync(target, 'utf8'), 'untouched target\n')
  assert.equal(lstatSync(join(directory, 'identity.key')).isSymbolicLink(), true)
})

test('fingerprints hash exactly 32 raw bytes and reject anything else with a coded error', () => {
  assert.equal(
    fingerprintFromPublicKey(Buffer.alloc(32)),
    'sha256:66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
  )
  const filled = Buffer.alloc(32, 7)
  assert.equal(fingerprintFromPublicKey(filled), `sha256:${createHash('sha256').update(filled).digest('hex')}`)
  assert.match(fingerprintFromPublicKey(new Uint8Array(32).fill(3)), FINGERPRINT_PATTERN)
  for (const bad of [Buffer.alloc(31), Buffer.alloc(33), new Uint8Array(31), 'not-bytes', 42, {}, { length: 32 }, undefined]) {
    assert.throws(
      () => fingerprintFromPublicKey(bad),
      error => error instanceof Error
        && error.name === 'AgentRoomRuntimeError'
        && error.code === 'identity_key_invalid'
        && /raw 32-byte/.test(error.message),
    )
  }
})

function spawnKeypairChild(dataDir) {
  const script = [
    `import(${JSON.stringify(pathToFileURL(KEYS_MODULE).href)}).then(({ loadOrCreateKeypair }) => {`,
    `  const keypair = loadOrCreateKeypair(${JSON.stringify(dataDir)});`,
    `  process.stdout.write(keypair.fingerprint + '\\n');`,
    '}, error => {',
    `  process.stderr.write('keypair failed: ' + error.message + '\\n');`,
    '  process.exit(1);',
    '});',
  ].join('\n')
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectChild)
    child.once('exit', code => resolveChild({ code, stdout, stderr }))
  })
}

test('concurrent first loads converge on one key file and one fingerprint with no partial file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-room-keys-race-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const results = await Promise.all([spawnKeypairChild(directory), spawnKeypairChild(directory)])
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr)
  }
  const fingerprints = results.map(result => result.stdout.trim())
  assert.equal(fingerprints[1], fingerprints[0], 'both loaders must agree on one identity')
  assert.match(fingerprints[0], FINGERPRINT_PATTERN)

  // Exactly one key file survived — no temporary or partial leftovers.
  assert.deepEqual(readdirSync(directory).sort(), ['identity.key'])
  const keypair = loadOrCreateKeypair(directory)
  assert.equal(keypair.fingerprint, fingerprints[0])
})
