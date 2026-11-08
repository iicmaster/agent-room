// DDD import-direction ratchet (agent-room migration): prevent new private
// cross-context imports. Modular monolith; this ratchet is phase-aware and
// lists every temporary edge with an owner/removal gate.

import assert from 'node:assert/strict'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'server')
const CONTEXTS = Object.freeze({
  identity: join(SERVER, 'identity'),
  messaging: join(SERVER, 'messaging'),
  notification: join(SERVER, 'notification'),
})
const EXTRACTED = new Set(['identity', 'messaging', 'notification'])
const DEFERRED = new Set()

// Explicit temporary adapters. Each has an owner and a removal gate in the
// DDD plan; the ratchet prevents adding unnamed coupling while legacy callers
// are migrated in later phases.
const TRANSITIONAL = new Map([
  ['identity', new Set([
    join(SERVER, 'store', 'bans.mjs'),
    join(SERVER, 'store', 'invites.mjs'),
    join(SERVER, 'store', 'room-log.mjs'), // temporary DB facade / shared schema composition port
    join(SERVER, 'store', 'bans.mjs'),
    join(SERVER, 'store', 'invites.mjs'),
    join(SERVER, 'store', 'room-log.mjs'), // temporary DB facade
  ])],
  ['notification', new Set([
    join(SERVER, 'client', 'api-client.mjs'),
    join(SERVER, 'client', 'cursors.mjs'), // the read-only cursor reader (v0.8.0 catch-up)
    join(SERVER, 'client', 'trust.mjs'), // TODO DDD phase: move classifier implementation behind this port
  ])],
])

function modulesUnder(directory) {
  const out = []
  let entries
  try { entries = readdirSync(directory) } catch (error) { if (error?.code === 'ENOENT') return out; throw error }
  for (const name of entries.sort()) {
    const file = join(directory, name)
    const st = lstatSync(file)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) out.push(...modulesUnder(file))
    else if (name.endsWith('.mjs')) out.push(file)
  }
  return out
}

function imports(source) {
  return [...source.matchAll(/\b(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)].map(match => match[1])
}
function resolveRelative(specifier, sourceFile) { return resolve(dirname(sourceFile), specifier) }
function within(file, directory) { return file === directory || file.startsWith(`${directory}${sep}`) }

// The same rules, applied to ONE file. Split out so the negative fixture
// below can feed a forged import through the real checks instead of asserting
// that a file which does not exist is absent from the results — which it
// always was, which is why that assertion proved nothing for three phases.
function findingsForSource(sourceFile, source) {
  const findings = []
  for (const owner of EXTRACTED) {
    if (!within(sourceFile, CONTEXTS[owner])) continue
    {
      for (const specifier of imports(source)) {
        if (!specifier.startsWith('.')) continue
        const target = resolveRelative(specifier, sourceFile)
        for (const other of EXTRACTED) {
          if (other !== owner && within(target, CONTEXTS[other])) findings.push(`${relative(ROOT, sourceFile)} -> private ${other}: ${specifier}`)
        }
        const allow = TRANSITIONAL.get(owner) ?? new Set()
        if (owner === 'identity' && within(target, join(SERVER, 'store')) && !allow.has(target)) {
          findings.push(`${relative(ROOT, sourceFile)} -> unlisted store adapter: ${specifier}`)
        }
        if (owner === 'messaging' && (within(target, join(SERVER, 'identity')) || within(target, join(SERVER, 'notification')) || within(target, join(SERVER, 'store')) || within(target, join(SERVER, 'api')))) {
          findings.push(`${relative(ROOT, sourceFile)} -> cross-context/private adapter: ${specifier}`)
        }
        if (owner === 'notification' && within(target, join(SERVER, 'client')) && !allow.has(target)) {
          findings.push(`${relative(ROOT, sourceFile)} -> unlisted client adapter: ${specifier}`)
        }
        if ((owner === 'identity' || owner === 'notification') && (within(target, join(SERVER, 'api')) || within(target, join(SERVER, 'core')))) {
          findings.push(`${relative(ROOT, sourceFile)} -> outer/server internals: ${specifier}`)
        }
      }
    }
  }
  return findings
}

function boundaryFindings() {
  const findings = []
  for (const owner of EXTRACTED) {
    const root = CONTEXTS[owner]
    for (const sourceFile of modulesUnder(root)) {
      findings.push(...findingsForSource(sourceFile, readFileSync(sourceFile, 'utf8')))
    }
  }
  return findings
}

test('phase-aware DDD import ratchet: extracted contexts exist and obey import direction', () => {
  for (const name of EXTRACTED) assert.ok(modulesUnder(CONTEXTS[name]).length > 0, `${relative(ROOT, CONTEXTS[name])} must be populated`)
  assert.equal(DEFERRED.size, 0, 'no current context is a placeholder')
  assert.deepEqual(boundaryFindings(), [])
})

test('Identity owns claims/enrollment SQL; store owns schema and delegates the facade', () => {
  const identity = readFileSync(join(CONTEXTS.identity, 'claims.mjs'), 'utf8')
  const repository = readFileSync(join(CONTEXTS.identity, 'repository.mjs'), 'utf8')
  const store = readFileSync(join(SERVER, 'store', 'room-log.mjs'), 'utf8')
  for (const operation of ['upsertChatIdClaim', 'listClaimsForChatId', 'recentClaims', 'pruneChatIdClaims', 'enrollActor', 'isActorEnrolled']) {
    assert.match(identity, new RegExp(`\\b${operation}\\(`), `Identity must own ${operation}`)
    assert.match(store, new RegExp(`identityOperations\\.${operation}`), `store facade must delegate ${operation}`)
  }
  assert.match(repository, /createBanOperations/)
  assert.match(repository, /createInviteOperations/)
  assert.match(store, /ensureChatIdClaimsTable/)
  assert.match(store, /ROOM_LOG_SCHEMA_VERSION/)
  assert.match(store, /database\.close\(\)/)
})

test('Notification never reaches server API/store/core; the ratchet rejects a forged dependency', () => {
  const file = join(CONTEXTS.notification, 'forbidden.mjs')
  const specifier = '../api/server.mjs'
  const target = resolveRelative(specifier, file)
  assert.ok(within(target, join(SERVER, 'api')))

  // Feed the forged import through the real rule set. The previous version
  // asserted only that no finding MENTIONED a file that does not exist, so it
  // passed whatever the rules did.
  const forged = findingsForSource(file, `import { serve } from '${specifier}'\n`)
  assert.ok(forged.length > 0, 'the ratchet must reject a Notification module importing server/api')
  assert.ok(forged.some(finding => finding.includes('forbidden.mjs') && finding.includes('outer/server internals')))

  // The same rule set still accepts a legitimate intra-context import.
  assert.deepEqual(findingsForSource(file, "import { loadWakePolicy } from './wake-policy.mjs'\n"), [])
})
