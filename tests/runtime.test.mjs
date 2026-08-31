import assert from 'node:assert/strict'
import { lstatSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
