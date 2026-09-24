import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  AgentRoomRuntimeError,
  assertSupportedRuntime,
  compareVersions,
  instanceDataDirectory,
  loadOrCreateIdentity,
  loadOrCreateViewerToken,
  sharedDataDirectory,
} from '../server/runtime.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRYPOINTS = [
  join(ROOT, 'server', 'mcp-stdio.mjs'),
  join(ROOT, 'server', 'roomd.mjs'),
]

test('version comparison and runtime gates reject unsafe SQLite builds', () => {
  assert.equal(compareVersions('3.51.3', '3.51.3'), 0)
  assert.equal(compareVersions('3.53.4', '3.51.3'), 1)
  assert.equal(compareVersions('3.50.9', '3.51.3'), -1)
  assert.deepEqual(
    assertSupportedRuntime({ nodeVersion: '24.18.1', sqliteVersion: '3.51.3' }),
    { nodeVersion: '24.18.1', sqliteVersion: '3.51.3' },
  )
  assert.throws(
    () => assertSupportedRuntime({ nodeVersion: '22.20.0', sqliteVersion: '3.53.4' }),
    error => error instanceof AgentRoomRuntimeError && error.code === 'node_version_unsupported',
  )
  assert.throws(
    () => assertSupportedRuntime({ nodeVersion: '24.18.1', sqliteVersion: '3.51.2' }),
    error => error instanceof AgentRoomRuntimeError && error.code === 'sqlite_version_unsupported',
  )
})

test('the Node gate holds the ratified 24.15 floor and names the found version', () => {
  assert.deepEqual(
    assertSupportedRuntime({ nodeVersion: '24.15.0', sqliteVersion: '3.53.4' }),
    { nodeVersion: '24.15.0', sqliteVersion: '3.53.4' },
  )
  assert.deepEqual(
    assertSupportedRuntime({ nodeVersion: '25.2.1', sqliteVersion: '3.53.4' }),
    { nodeVersion: '25.2.1', sqliteVersion: '3.53.4' },
  )
  for (const below of ['24.14.9', '24.14', '23.11.0', 'garbage']) {
    assert.throws(
      () => assertSupportedRuntime({ nodeVersion: below, sqliteVersion: '3.53.4' }),
      error => {
        assert.ok(error instanceof AgentRoomRuntimeError)
        assert.equal(error.code, 'node_version_unsupported')
        assert.match(error.message, /Node 24\.15 or newer/)
        assert.match(error.message, /found /)
        return true
      },
    )
  }
  assert.throws(
    () => assertSupportedRuntime({ nodeVersion: '24.14.9', sqliteVersion: '3.53.4' }),
    error => error.message.includes('found 24.14.9'),
  )
  // Empty-string versions must render as "found unknown", never a bare "found ".
  assert.throws(
    () => assertSupportedRuntime({ nodeVersion: '', sqliteVersion: '3.53.4' }),
    error => error.message.includes('found unknown') && !error.message.includes('found  '),
  )
  assert.throws(
    () => assertSupportedRuntime({ nodeVersion: '24.15.0', sqliteVersion: '' }),
    error => error.message.includes('found unknown'),
  )
})

test('the SQLite gate names the failed gate and the found version', () => {
  assert.throws(
    () => assertSupportedRuntime({ nodeVersion: '24.15.0', sqliteVersion: '3.51.2' }),
    error => {
      assert.ok(error instanceof AgentRoomRuntimeError)
      assert.equal(error.code, 'sqlite_version_unsupported')
      assert.match(error.message, /SQLite 3\.51\.3 or newer/)
      assert.match(error.message, /found 3\.51\.2/)
      return true
    },
  )
  assert.throws(
    // null bypasses the process.versions default without triggering it.
    () => assertSupportedRuntime({ nodeVersion: '24.15.0', sqliteVersion: null }),
    error => error.message.includes('found unknown'),
  )
})

function runEntrypointWithVersions(entrypoint, versions) {
  const defineLines = Object.entries(versions).map(([field, value]) =>
    `Object.defineProperty(process.versions, ${JSON.stringify(field)}, { value: ${JSON.stringify(value)} });`)
  const script = [
    ...defineLines,
    `import(${JSON.stringify(pathToFileURL(entrypoint).href)}).then(`,
    '  () => process.exit(0),',
    `  error => { process.stderr.write('entrypoint gate failed: ' + (error?.code ?? 'unknown') + ': ' + error?.message + '\\n'); process.exit(1); },`,
    ');',
  ].join('\n')
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', code => resolveRun({ code, stderr }))
  })
}

test('every entrypoint exits non-zero when Node is below the 24.15 floor', async () => {
  for (const entrypoint of ENTRYPOINTS) {
    const { code, stderr } = await runEntrypointWithVersions(entrypoint, { node: '24.14.9' })
    assert.notEqual(code, 0, `${entrypoint} must refuse to start`)
    assert.match(stderr, /node_version_unsupported/)
    assert.match(stderr, /Node 24\.15 or newer/)
    assert.match(stderr, /24\.14\.9/)
  }
})

test('every entrypoint exits non-zero when bundled SQLite is below 3.51.3', async () => {
  for (const entrypoint of ENTRYPOINTS) {
    const { code, stderr } = await runEntrypointWithVersions(entrypoint, { sqlite: '3.51.2' })
    assert.notEqual(code, 0, `${entrypoint} must refuse to start`)
    assert.match(stderr, /sqlite_version_unsupported/)
    assert.match(stderr, /SQLite 3\.51\.3 or newer/)
    assert.match(stderr, /3\.51\.2/)
  }
})

test('entrypoints started exactly at the floor import cleanly and exit zero', async () => {
  for (const entrypoint of ENTRYPOINTS) {
    const { code, stderr } = await runEntrypointWithVersions(entrypoint, { node: '24.15.0' })
    assert.equal(code, 0, `${entrypoint} must start at the floor; stderr=${stderr}`)
    assert.equal(stderr, '')
  }
})

test('portable and Claude instance data paths are explicit and shared state override is separate', () => {
  assert.equal(instanceDataDirectory({ PLUGIN_DATA: '/tmp/plugin-a' }, '/ignored'), '/tmp/plugin-a')
  assert.equal(instanceDataDirectory({ CLAUDE_PLUGIN_DATA: '/tmp/plugin-b' }, '/ignored'), '/tmp/plugin-b')
  assert.notEqual(instanceDataDirectory({}, '/tmp/project-that-must-not-be-chmodded'), '/tmp/project-that-must-not-be-chmodded')
  assert.match(instanceDataDirectory({}, '/ignored'), /[\\/]\.agent-room[\\/]client-data[\\/]manual$/)
  assert.equal(sharedDataDirectory({ AGENT_ROOM_DATA_DIR: '/tmp/shared-room' }), '/tmp/shared-room')
  assert.throws(
    () => sharedDataDirectory({ AGENT_ROOM_DATA_DIR: 'relative' }),
    error => error.code === 'AGENT_ROOM_DATA_DIR_not_absolute',
  )
})

test('identity and viewer token are stable bounded private files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-room-runtime-'))
  try {
    const first = loadOrCreateIdentity(directory, 'Codex')
    const second = loadOrCreateIdentity(directory, 'Someone else')
    assert.equal(second.id, first.id)
    assert.equal(second.displayName, 'Codex')
    assert.match(first.id, /^agent:/)
    assert.equal(lstatSync(first.path).mode & 0o777, 0o600)

    const tokenA = loadOrCreateViewerToken(directory)
    const tokenB = loadOrCreateViewerToken(directory)
    assert.equal(tokenA, tokenB)
    assert.match(tokenA, /^[A-Za-z0-9_-]{32,256}$/)
    assert.equal(lstatSync(join(directory, 'viewer-token')).mode & 0o777, 0o600)
    assert.equal(readFileSync(join(directory, 'viewer-token'), 'utf8').trim(), tokenA)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
