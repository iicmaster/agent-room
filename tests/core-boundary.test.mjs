// Hexagonal boundary walk (Story 1.3): server/core/ is the pure core. It may
// import node: builtins (except transport), repo-relative modules, and nothing
// else — no node:http/https transport, no MCP SDK, no CLI library, and never a
// transport adapter (api host, daemon, MCP stdio entrypoint, web assets).

import assert from 'node:assert/strict'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORE_DIRECTORY = join(ROOT, 'server', 'core')
const SERVER_DIRECTORY = join(ROOT, 'server')

// Transport adapters and surfaces the core must never import (one-way rule:
// adapters -> core -> store).
const FORBIDDEN_IMPORTS = new Set([
  join(SERVER_DIRECTORY, 'api'),
  join(SERVER_DIRECTORY, 'roomd.mjs'),
  join(SERVER_DIRECTORY, 'daemon-client.mjs'),
  join(SERVER_DIRECTORY, 'mcp-stdio.mjs'),
  join(ROOT, 'web'),
  join(ROOT, 'scripts'),
])

const FORBIDDEN_NODE_BUILTINS = new Set(['node:http', 'node:https'])

// Symlink-safe walk mirroring tests/constants.test.mjs.
function listModules(directory) {
  const found = []
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return found
    throw error
  }
  for (const name of names.sort()) {
    const path = join(directory, name)
    let info
    try {
      info = lstatSync(path)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) found.push(...listModules(path))
    else if (name.endsWith('.mjs')) found.push(path)
  }
  return found
}

function importSpecifiers(source) {
  const specifiers = []
  for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1])
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1])
  }
  for (const match of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1])
  }
  return specifiers
}

function resolvesInside(specifier, fromFile, directory) {
  if (specifier.startsWith('node:')) return false
  const target = isAbsolute(specifier)
    ? specifier
    : resolve(dirname(fromFile), specifier)
  return target === directory || target.startsWith(`${directory}${sep}`)
}

test('the core exists and is populated', () => {
  const modules = listModules(CORE_DIRECTORY)
  assert.ok(modules.length >= 1, 'server/core/ must contain at least one module')
})

test('core imports no transport, no MCP SDK, no CLI library, and no adapter', () => {
  const offenders = []
  for (const path of listModules(CORE_DIRECTORY)) {
    const source = readFileSync(path, 'utf8')
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith('node:')) {
        if (FORBIDDEN_NODE_BUILTINS.has(specifier)) {
          offenders.push(`${relative(ROOT, path)}: ${specifier} (transport is an adapter concern)`)
        }
        continue
      }
      if (specifier.startsWith('.')) {
        const forbidden = [...FORBIDDEN_IMPORTS].find(directory => resolvesInside(specifier, path, directory))
        if (forbidden) {
          offenders.push(`${relative(ROOT, path)}: ${specifier} (imports the adapter ${relative(ROOT, forbidden)})`)
        }
        continue
      }
      // Any bare specifier is an external dependency: zero-deps policy, and
      // it is exactly how an MCP SDK or CLI library would enter the core.
      offenders.push(`${relative(ROOT, path)}: ${specifier} (bare specifiers are external dependencies)`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('the core fabricates no identity: realm bootstrap contains no fingerprint literal', () => {
  for (const path of listModules(CORE_DIRECTORY)) {
    const source = readFileSync(path, 'utf8')
    assert.equal(/sha256:/.test(source), false, `${relative(ROOT, path)} must not embed any fingerprint`)
    assert.equal(/'0'\.repeat|0{16,}/.test(source), false, `${relative(ROOT, path)} must not embed sentinel hex runs`)
  }
})

test('the boundary rules actually bite (the walker is not vacuous)', () => {
  // The same rules the walk applies must flag a violating import: both a
  // transport builtin and a bare CLI/MCP-style specifier.
  const violating = ["import { createServer } from 'node:http'", "import x from 'some-cli-lib'"]
  const flagged = importSpecifiers(violating.join('\n'))
    .filter(specifier => FORBIDDEN_NODE_BUILTINS.has(specifier) || (!specifier.startsWith('node:') && !specifier.startsWith('.')))
  assert.deepEqual(flagged, ['node:http', 'some-cli-lib'])
  // The resolver: an api import from a core file resolves into the forbidden
  // adapter directory; a store import does not.
  assert.equal(
    resolvesInside('../api/server.mjs', join(CORE_DIRECTORY, 'realm.mjs'), join(SERVER_DIRECTORY, 'api')),
    true,
  )
  assert.equal(
    resolvesInside('../store/room-log.mjs', join(CORE_DIRECTORY, 'realm.mjs'), join(SERVER_DIRECTORY, 'api')),
    false,
  )
})
