import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ensureDaemon } from '../server/daemon-client.mjs'
import { startupLockPath } from '../server/runtime.mjs'

async function assertInvalidLock(dataDir) {
  const started = Date.now()
  await assert.rejects(
    ensureDaemon({ dataDir }),
    error => error?.code === 'daemon_start_lock_invalid',
  )
  assert.ok(Date.now() - started < 1_000, 'malformed lock must fail without blocking the event loop')
}

test('oversized startup lock fails closed without reading the whole file repeatedly', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-room-lock-large-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  writeFileSync(startupLockPath(dataDir), Buffer.alloc(4096, 0x61))
  await assertInvalidLock(dataDir)
})

test('FIFO startup lock cannot block daemon discovery', { skip: process.platform === 'win32' }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-room-lock-fifo-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const result = spawnSync('mkfifo', [startupLockPath(dataDir)], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  await assertInvalidLock(dataDir)
})
