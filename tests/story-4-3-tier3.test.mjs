// Story 4.3 AC1 — Tier 3 shell-free notify runner. Focused, zero server:
// real child processes, real temp dirs, real lstat/realpath, injected seams.
// Oracles are literals in this file.

import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  TIER3_TIMEOUT_MS,
  NOTIFY_CMD_TIMEOUT_MS,
  NOTIFY_ENV_ALLOWLIST,
  NOTIFY_GATE_ENUM,
  DOCTOR_PROBE_TIMEOUT_MS,
  DOCTOR_TOTAL_BUDGET_MS,
} from '../server/constants.mjs'
import {
  buildTier3Env,
  normalizeNotifyCommand,
  notifyMetadata,
  redactTier3Error,
  runTier3Notify,
  verifyExecutable,
} from '../server/notification/tier3-notify.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function tmp() { return mkdtempSync(join(tmpdir(), 'story-4-3-tier3-')) }
function script(path, body) {
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 })
  chmodSync(path, 0o700)
}

test('4.3 constants: Tier 3 budget is 1 s and the gate enum is the closed 5-state set', () => {
  assert.equal(TIER3_TIMEOUT_MS, 1000)
  assert.equal(NOTIFY_CMD_TIMEOUT_MS, TIER3_TIMEOUT_MS)
  assert.equal(DOCTOR_PROBE_TIMEOUT_MS, 1000)
  assert.equal(DOCTOR_TOTAL_BUDGET_MS, 3000)
  assert.deepEqual([...NOTIFY_ENV_ALLOWLIST], [
    'AGENT_ROOM_ROOM_ID', 'AGENT_ROOM_SEQ', 'AGENT_ROOM_FROM_ADDRESS', 'AGENT_ROOM_TRUSTED',
  ])
  assert.deepEqual([...NOTIFY_GATE_ENUM], [
    'Server-enforced', 'Plugin-enforced', 'Host-channel-enforced', 'Host-hook-enforced', 'Instructed',
  ])
})

test('Tier 3 sends ONLY allowlisted metadata to env, passes no argv, drops secrets, neutralizes injection literals', async () => {
  const dir = tmp()
  const out = join(dir, 'capture.json')
  const exe = join(dir, 'notify')
  script(exe, `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(out)}, JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    room: process.env.AGENT_ROOM_ROOM_ID, seq: process.env.AGENT_ROOM_SEQ,
    from: process.env.AGENT_ROOM_FROM_ADDRESS, trusted: process.env.AGENT_ROOM_TRUSTED,
  },
  leaked: Object.keys(process.env).filter(k => k.startsWith('AGENT_ROOM_') && !${JSON.stringify([...NOTIFY_ENV_ALLOWLIST])}.includes(k)),
}))`)
  const hostile = '$(touch /tmp/PWNED_43);x\n"quote" \\ `id` 拼接'
  const metadata = notifyMetadata({ room_id: 'room:abc', seq: 7, chat_id: hostile, trusted: true })
  const env = { PATH: process.env.PATH, AGENT_ROOM_TOKEN: 'TOP_SECRET', AGENT_ROOM_NOTIFY_CMD: exe }
  const result = await runTier3Notify({ config: normalizeNotifyCommand(exe), metadata, env, errorOutput: { write() {} } })
  assert.equal(result.ok, true, JSON.stringify(result))
  const cap = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(cap.argv, [], 'no metadata in argv')
  assert.deepEqual(cap.leaked, [], 'no token/secret/unlisted AGENT_ROOM_* leaked')
  assert.equal(cap.env.room, 'room:abc')
  assert.equal(cap.env.seq, '7')
  assert.equal(cap.env.trusted, 'true')
  assert.equal(cap.env.from.includes('\n'), false, 'newline stripped')
  assert.equal(cap.env.from.includes('$(touch'), true, 'injection literal kept as inert data')
})

test('buildTier3Env drops every non-allowlisted AGENT_ROOM_* variable', () => {
  const env = { PATH: '/bin', AGENT_ROOM_SECRET: 'x', AGENT_ROOM_SESSION_CAPABILITY: 'y', HOME: '/h' }
  const built = buildTier3Env(notifyMetadata({ room_id: 'r', seq: 1 }), { env })
  assert.equal(built.AGENT_ROOM_SECRET, undefined)
  assert.equal(built.AGENT_ROOM_SESSION_CAPABILITY, undefined)
  assert.equal(built.PATH, '/bin')
  assert.equal(typeof built.AGENT_ROOM_ROOM_ID, 'string')
})

test('verifyExecutable: symlink escape, whitespace path, non-executable, and missing file are all refused', () => {
  const dir = tmp()
  const exe = join(dir, 'ok')
  script(exe, '')
  assert.equal(verifyExecutable(exe, { mode: 'path' }).ok, true)
  const link = join(dir, 'link')
  symlinkSync(exe, link)
  assert.equal(verifyExecutable(link, { mode: 'path' }).reason, 'symlink-escape')
  assert.equal(verifyExecutable('/tmp/a b', { mode: 'path' }).reason, 'whitespace-in-path')
  chmodSync(exe, 0o600)
  assert.equal(verifyExecutable(exe, { mode: 'path' }).reason, 'not-executable')
  assert.equal(verifyExecutable(join(dir, 'missing'), { mode: 'path' }).reason, 'not-found')
})

test('verifyExecutable: argv-array mode allows literal arguments while still verifying argv[0]', () => {
  const dir = tmp()
  const exe = join(dir, 'ok')
  script(exe, '')
  assert.equal(verifyExecutable(exe, { mode: 'argv' }).ok, true)
  assert.equal(verifyExecutable(join(dir, 'has space'), { mode: 'argv' }).reason, 'not-found')
})

test('Tier 3 failure / nonzero / timeout: 0 retries, redacted reason only', async () => {
  const dir = tmp()
  // timeout helper: exactly one invocation, then hang
  const countPath = join(dir, 'count')
  const slow = join(dir, 'slow')
  script(slow, `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(countPath)}, 'x')
setTimeout(() => {}, 5000)`)
  const t0 = Date.now()
  const timeout = await runTier3Notify({ config: normalizeNotifyCommand(slow), metadata: {}, env: { PATH: process.env.PATH }, errorOutput: { write() {} } })
  const elapsed = Date.now() - t0
  assert.equal(timeout.ok, false)
  assert.equal(timeout.reason, 'timeout')
  assert.ok(elapsed < 1600, `timeout bounded, elapsed=${elapsed}`)
  assert.equal(readFileSync(countPath, 'utf8').length, 1, 'exactly one invocation — 0 retries')

  // nonzero exit with a raw secret on stderr: reason is redacted to exit:N;
  // no raw message text is surfaced
  const fail = join(dir, 'fail')
  script(fail, `process.stderr.write('LEAKED_SECRET_INPUT'); process.exit(7)`)
  const lines = []
  const failResult = await runTier3Notify({ config: normalizeNotifyCommand(fail), metadata: {}, env: { PATH: process.env.PATH }, errorOutput: { write: s => lines.push(s) } })
  assert.equal(failResult.ok, false)
  assert.equal(failResult.reason, 'exit:7')
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes('LEAKED_SECRET_INPUT'), 'redacted diagnostic never carries child output')
})

test('redactTier3Error never echoes raw error messages', () => {
  assert.equal(redactTier3Error({ code: 'ENOENT', message: 'secret/path/leak' }), 'ENOENT')
  assert.equal(redactTier3Error({ killed: true, message: 'x' }), 'timeout')
  assert.equal(redactTier3Error({ code: 9, message: 'x' }), 'exit:9')
  assert.equal(redactTier3Error({ message: 'leak me' }), 'error')
})

test('unconfigured Tier 3 is an honest skip (no execution, no failure)', async () => {
  const result = await runTier3Notify({ env: {}, errorOutput: { write() {} } })
  assert.deepEqual(result, { ok: true, skipped: true, reason: 'not-configured' })
})
