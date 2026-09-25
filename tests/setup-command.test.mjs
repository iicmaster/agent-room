// Story 1.7 acceptance: the one-time `agent-room setup` command. The rows are
// TTY-free: the interactive flow runs against injected stream fixtures (a
// PassThrough carrying .isTTY) with a real spawned server behind it, and the
// non-TTY row proves the command prompts nothing and touches nothing without
// a terminal. Covered: the happy path (name validated, verified claimable,
// released, config stored at 0600), the DR-1 grammar retry (a malformed name
// is re-prompted and never probed), the live-collision retry loop (refused,
// re-prompted, and NO config written until a free name is accepted), and the
// release guarantee (the probed name is claimable by the very next session).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { runSetup, SETUP_REQUIRES_TTY_MESSAGE } from '../server/cli/agent-room.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const CONFIG_FILENAME = 'config.json'
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function makeWorld(t) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-setup-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(sharedData, { mode: 0o700 })
  mkdirSync(pluginData, { mode: 0o700 })

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: sharedData },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const waitReady = async () => {
    const deadline = Date.now() + 10 * 1000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('server child exited early')
      if (existsSync(join(sharedData, 'runtime.json'))) {
        try {
          const record = JSON.parse(readFileSync(join(sharedData, 'runtime.json'), 'utf8'))
          if (Number.isInteger(record.port) && record.port > 0) return record
        } catch { /* atomic rename: readers retry */ }
      }
      if (Date.now() > deadline) throw new Error('server child never became ready')
      await sleep(25)
    }
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })

  return { parent, sharedData, pluginData, waitReady }
}

// An interactive fixture: a TTY-flagged stream the test writes lines into.
function interactiveInput() {
  const input = new PassThrough()
  input.isTTY = true
  return input
}

// Echo collector for the command's prompts and confirmations.
function collectEcho(output) {
  let echoed = ''
  output.setEncoding('utf8')
  output.on('data', chunk => { echoed += chunk })
  return {
    waitFor: async pattern => {
      const deadline = Date.now() + 5 * 1000
      for (;;) {
        if (pattern.test(echoed)) return echoed
        if (Date.now() > deadline) throw new Error(`the command never echoed ${pattern}; got: ${JSON.stringify(echoed)}`)
        await sleep(50)
      }
    },
    text: () => echoed,
  }
}

function httpRequest(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', rejectPromise)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolvePromise({ status: response.statusCode, json: () => JSON.parse(text), text })
        })
      },
    )
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

async function connectInstallation(port, sharedData, chatId) {
  const localToken = loadOrCreateLocalToken(sharedData)
  const { publicKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const auth = await httpRequest(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${localToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: { public_key: raw.toString('base64url') },
  })
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const connected = await httpRequest(port, 'POST', '/api/session', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: { chat_id: chatId },
  })
  assert.equal(connected.status, 200, connected.text)
  return { sessionToken }
}

function claimRows(sharedData) {
  const db = new DatabaseSync(join(sharedData, 'agent-room.sqlite'))
  try {
    return db.prepare(`
      SELECT chat_id_normalized, actor_fingerprint, chat_id_display, last_seen_at
      FROM chat_id_claims
      ORDER BY chat_id_display, actor_fingerprint
    `).all()
  } finally {
    db.close()
  }
}

test('setup happy path: the name is validated, verified claimable, released, and the config is stored at 0600', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const input = interactiveInput()
  const output = new PassThrough()
  t.after(() => {
    input.end()
    output.end()
  })
  const echo = collectEcho(output)
  const waitForEcho = echo.waitFor

  const pending = runSetup({
    input,
    output,
    sharedDataDir: world.sharedData,
    pluginDataDir: world.pluginData,
  })
  await waitForEcho(/Choose a Chat ID/)
  input.write('Bobby\n')
  const outcome = await pending

  assert.deepEqual(Object.keys(outcome).sort(), ['chatId', 'configPath', 'status'])
  assert.equal(outcome.status, 'configured')
  assert.equal(outcome.chatId, 'Bobby')

  const configPath = join(world.pluginData, CONFIG_FILENAME)
  assert.equal(outcome.configPath, configPath)
  const configStat = statSync(configPath)
  assert.equal(configStat.mode & 0o777, 0o600, 'the stored config is 0600')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(config.chat_id, 'Bobby')
  assert.ok(!Number.isNaN(Date.parse(config.set_up_at)))

  // The probe left the durable claim (ambiguity data)…
  assert.deepEqual(claimRows(world.sharedData).map(row => row.chat_id_normalized), ['bobby'])
  // …and released the live name: the very next session claims it.
  const nextClaim = await connectInstallation(record.port, world.sharedData, 'Bobby')
  assert.ok(nextClaim.sessionToken)

  // The human saw the prompt and the confirmation, never a credential.
  await waitForEcho(/Bobby/)
  assert.equal(echo.text().includes('session_token'), false)
})

test('setup grammar retry: a malformed name is re-prompted and never probed', async t => {
  const world = makeWorld(t)
  await world.waitReady()
  const input = interactiveInput()
  const output = new PassThrough()
  t.after(() => {
    input.end()
    output.end()
  })
  const echo = collectEcho(output)
  const waitForEcho = echo.waitFor

  const pending = runSetup({
    input,
    output,
    sharedDataDir: world.sharedData,
    pluginDataDir: world.pluginData,
  })
  await waitForEcho(/Choose a Chat ID/)
  input.write('bad name!\n')
  await waitForEcho(/not a valid Chat ID/)
  input.write('Bobby\n')
  const outcome = await pending

  assert.equal(outcome.status, 'configured')
  assert.equal(outcome.chatId, 'Bobby')
  // The malformed attempt was refused at the grammar gate and never probed:
  // exactly one claim row exists (the accepted name's probe).
  assert.equal(claimRows(world.sharedData).length, 1)
})

test('setup collision retry: a live-taken name is refused and re-prompted; no config until a free name lands', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  // A peer already holds "Bobby" live.
  await connectInstallation(record.port, world.sharedData, 'Bobby')

  const input = interactiveInput()
  const output = new PassThrough()
  t.after(() => {
    input.end()
    output.end()
  })
  const echo = collectEcho(output)
  const waitForEcho = echo.waitFor

  const pending = runSetup({
    input,
    output,
    sharedDataDir: world.sharedData,
    pluginDataDir: world.pluginData,
  })
  await waitForEcho(/Choose a Chat ID/)
  input.write('Bobby\n')
  // The probe must fail against the live holder BEFORE any config exists.
  await waitForEcho(/already claimed live/)
  assert.equal(existsSync(join(world.pluginData, CONFIG_FILENAME)), false, 'a refused probe writes no config')
  input.write('Bobby-2\n')
  const outcome = await pending

  assert.equal(outcome.status, 'configured')
  assert.equal(outcome.chatId, 'Bobby-2')
  assert.equal(JSON.parse(readFileSync(join(world.pluginData, CONFIG_FILENAME), 'utf8')).chat_id, 'Bobby-2')
  // Both names now hold durable claims (the peer's and the released probe),
  // and the retried name was freed exactly like the happy path.
  assert.deepEqual(
    claimRows(world.sharedData).map(row => row.chat_id_normalized).sort(),
    ['bobby', 'bobby-2'],
  )
})

test('setup without a TTY prompts nothing, touches nothing, and answers guidance', async t => {
  const world = makeWorld(t)
  await world.waitReady()
  const input = new PassThrough() // no isTTY: pipes, hosts, CI
  input.write('Bobby\n')
  const output = new PassThrough()
  let echoed = ''
  output.setEncoding('utf8')
  output.on('data', chunk => { echoed += chunk })

  const outcome = await runSetup({
    input,
    output,
    sharedDataDir: world.sharedData,
    pluginDataDir: world.pluginData,
  })

  assert.equal(outcome.status, 'not-a-tty')
  assert.match(outcome.message, /interactive terminal/)
  assert.match(outcome.message, /agent-room setup/)
  assert.equal(SETUP_REQUIRES_TTY_MESSAGE.length > 0, true)
  // Nothing was probed and nothing was stored: no claim row, no config.
  assert.equal(existsSync(join(world.pluginData, CONFIG_FILENAME)), false)
  assert.deepEqual(claimRows(world.sharedData), [])
  await sleep(50)
  assert.equal(echoed, '', 'not a single prompt byte was written')
})

test('setup aborts cleanly when the input ends before a name is chosen', async t => {
  const world = makeWorld(t)
  await world.waitReady()
  const input = interactiveInput()
  const output = new PassThrough()
  t.after(() => {
    input.end()
    output.end()
  })
  const echo = collectEcho(output)
  const waitForEcho = echo.waitFor

  const pending = runSetup({
    input,
    output,
    sharedDataDir: world.sharedData,
    pluginDataDir: world.pluginData,
  })
  await waitForEcho(/Choose a Chat ID/)
  input.end()
  const outcome = await pending

  assert.equal(outcome.status, 'aborted')
  assert.match(outcome.message, /no configuration was written/)
  assert.equal(existsSync(join(world.pluginData, CONFIG_FILENAME)), false)
})
