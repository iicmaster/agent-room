import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { requestDaemon } from '../server/daemon-client.mjs'
import { startRoomDaemon } from '../server/roomd.mjs'
import { MESSAGE_TEXT_MAX, READ_HOLD_MAX_MS, READ_PAGE_MAX } from '../server/constants.mjs'

const actor = (id, displayName) => ({ id, displayName })

async function readSseMessages(response, count, controller) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const messages = []
  let buffer = ''
  while (messages.length < count) {
    const chunk = await reader.read()
    assert.equal(chunk.done, false)
    buffer += decoder.decode(chunk.value, { stream: true })
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data: ')) messages.push(JSON.parse(line.slice('data: '.length)))
    }
  }
  controller.abort()
  return messages
}

const listen = (server, ...args) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(...args, resolve)
})

const close = server => new Promise(resolve => server.close(resolve))

test('shared daemon serializes chat, long-polls, and serves an authenticated read-only viewer', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-room-daemon-'))
  const roomd = await startRoomDaemon({ dataDir })
  t.after(async () => {
    await roomd.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const call = (method, params = {}, timeoutMs = 5_000) => requestDaemon({
    socketPath: roomd.socketPath,
    method,
    params,
    timeoutMs,
  })

  const status = await call('status')
  assert.equal(status.ok, true)
  assert.equal(status.protocolVersion, 1)
  assert.equal(status.journalMode, 'wal')
  assert.match(status.viewerUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/)

  const alice = actor('agent:alice', 'Alice')
  const bob = actor('agent:bob', 'Bob')
  const room = await call('room.create', { actor: alice, title: 'Architecture' })
  await call('room.join', { actor: bob, roomId: room.id, displayName: 'Bob' })

  const waiting = call('message.read', {
    actor: bob,
    roomId: room.id,
    afterSeq: 0,
    limit: 50,
    waitMs: 2_000,
  }, 4_000)
  await new Promise(resolve => setTimeout(resolve, 25))
  const sent = await call('message.send', {
    actor: alice,
    roomId: room.id,
    clientMessageId: 'alice-1',
    text: 'One durable message',
  })
  assert.equal(sent.duplicate, false)
  const read = await waiting
  assert.deepEqual(read.messages, [sent.message])
  assert.equal(read.next_seq, sent.message.seq)

  const cancellation = new AbortController()
  const cancelledRead = requestDaemon({
    socketPath: roomd.socketPath,
    method: 'message.read',
    params: {
      actor: bob,
      roomId: room.id,
      afterSeq: sent.message.seq,
      limit: 50,
      waitMs: READ_HOLD_MAX_MS,
    },
    timeoutMs: 25_000,
    signal: cancellation.signal,
  })
  await new Promise(resolve => setTimeout(resolve, 25))
  cancellation.abort()
  await assert.rejects(cancelledRead, error => error?.code === 'request_cancelled')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal((await call('status')).pendingWaiters, 0)

  const repeatedChunkSocket = createConnection(roomd.socketPath)
  await new Promise((resolve, reject) => {
    repeatedChunkSocket.once('connect', resolve)
    repeatedChunkSocket.once('error', reject)
  })
  repeatedChunkSocket.write(`${JSON.stringify({
    id: 'one-long-poll',
    method: 'message.read',
    params: {
      actor: bob,
      roomId: room.id,
      afterSeq: sent.message.seq,
      limit: 50,
      waitMs: READ_HOLD_MAX_MS,
    },
  })}\n`)
  for (let index = 0; index < 100; index += 1) repeatedChunkSocket.write('x')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal((await call('status')).pendingWaiters, 1)
  repeatedChunkSocket.destroy()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal((await call('status')).pendingWaiters, 0)

  const viewer = new URL(status.viewerUrl)
  const token = viewer.searchParams.get('token')
  const shellResponse = await fetch(viewer.origin)
  assert.equal(shellResponse.status, 200)
  assert.match(shellResponse.headers.get('content-type'), /^text\/html/)
  const missingToken = await fetch(new URL('/api/rooms', viewer.origin))
  assert.equal(missingToken.status, 401)
  const roomsResponse = await fetch(new URL(`/api/rooms?token=${encodeURIComponent(token)}`, viewer.origin))
  assert.equal(roomsResponse.status, 200)
  assert.deepEqual((await roomsResponse.json()).rooms, [room])

  const messagesResponse = await fetch(new URL(
    `/api/rooms/${encodeURIComponent(room.id)}/messages?after=0&limit=100&token=${encodeURIComponent(token)}`,
    viewer.origin,
  ))
  assert.equal(messagesResponse.status, 200)
  assert.deepEqual((await messagesResponse.json()).messages, [sent.message])

  const denied = await fetch(new URL('/api/rooms?token=wrong', viewer.origin))
  assert.equal(denied.status, 401)
  const wrongOrigin = await fetch(new URL(`/api/rooms?token=${encodeURIComponent(token)}`, viewer.origin), {
    headers: { Origin: 'https://attacker.invalid' },
  })
  assert.equal(wrongOrigin.status, 403)
  const writeAttempt = await fetch(new URL(`/api/rooms?token=${encodeURIComponent(token)}`, viewer.origin), {
    method: 'POST',
  })
  assert.equal(writeAttempt.status, 405)

  const malformedResponse = await new Promise((resolveMalformed, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(viewer.port) })
    let raw = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${viewer.port}\r\nConnection: close\r\n\r\n`))
    socket.on('data', chunk => { raw += chunk })
    socket.once('end', () => resolveMalformed(raw))
    socket.once('error', reject)
  })
  assert.match(malformedResponse, /^HTTP\/1\.1 400/)
  assert.equal((await call('status')).ok, true, 'malformed HTTP target must not crash the daemon')

  const streamController = new AbortController()
  const streamResponse = await fetch(new URL(
    `/api/rooms/${encodeURIComponent(room.id)}/events?after=0&token=${encodeURIComponent(token)}`,
    viewer.origin,
  ), { signal: streamController.signal })
  assert.equal(streamResponse.status, 200)
  assert.match(streamResponse.headers.get('content-type'), /^text\/event-stream/)
  assert.deepEqual(await readSseMessages(streamResponse, 1, streamController), [sent.message])

  const missingStream = await fetch(new URL(
    `/api/rooms/missing-room/events?after=0&token=${encodeURIComponent(token)}`,
    viewer.origin,
  ))
  assert.equal(missingStream.status, 400)
  assert.equal((await missingStream.json()).error.code, 'room_not_found')
  assert.equal((await call('status')).ok, true, 'invalid SSE request must not crash the daemon')

  for (let index = 2; index <= 205; index += 1) {
    roomd.database.sendMessage({
      roomId: room.id,
      actorId: alice.id,
      clientMessageId: `bulk-${index}`,
      text: `message ${index}`,
    })
  }
  const firstSmallPage = await call('message.read', {
    actor: alice,
    roomId: room.id,
    afterSeq: 0,
    limit: 50,
    waitMs: 0,
  })
  assert.equal(firstSmallPage.messages.length, 50)
  assert.equal(firstSmallPage.has_more, true)
  const backlogController = new AbortController()
  const backlogResponse = await fetch(new URL(
    `/api/rooms/${encodeURIComponent(room.id)}/events?after=0&token=${encodeURIComponent(token)}`,
    viewer.origin,
  ), { signal: backlogController.signal })
  const catchupFrame = await backlogResponse.text()
  assert.match(catchupFrame, /event: catchup_required/)
  assert.match(catchupFrame, /data: \{"after":0\}/)

  const caughtUp = []
  let catchupCursor = 0
  for (;;) {
    const pageResponse = await fetch(new URL(
      `/api/rooms/${encodeURIComponent(room.id)}/messages?after=${catchupCursor}&limit=100&token=${encodeURIComponent(token)}`,
      viewer.origin,
    ))
    const page = (await pageResponse.json()).messages
    caughtUp.push(...page)
    if (page.length < 100) break
    catchupCursor = page.at(-1).seq
  }
  assert.deepEqual(caughtUp.map(message => message.seq), Array.from({ length: 205 }, (_, index) => index + 1))

  // The viewer route clamps oversized page requests to the owned read bound.
  const clampedPage = await fetch(new URL(
    `/api/rooms/${encodeURIComponent(room.id)}/messages?after=0&limit=${READ_PAGE_MAX + 1}&token=${encodeURIComponent(token)}`,
    viewer.origin,
  ))
  assert.equal(clampedPage.status, 200)
  assert.equal((await clampedPage.json()).messages.length, READ_PAGE_MAX)

  const tailController = new AbortController()
  const tailResponse = await fetch(new URL(
    `/api/rooms/${encodeURIComponent(room.id)}/events?after=0&token=${encodeURIComponent(token)}`,
    viewer.origin,
  ), { signal: tailController.signal, headers: { 'Last-Event-ID': '200' } })
  const tail = await readSseMessages(tailResponse, 5, tailController)
  assert.deepEqual(tail.map(message => message.seq), [201, 202, 203, 204, 205])

  for (let index = 1; index <= 33; index += 1) {
    roomd.database.sendMessage({
      roomId: room.id,
      actorId: alice.id,
      clientMessageId: `large-${index}`,
      text: 'x'.repeat(MESSAGE_TEXT_MAX),
    })
  }
  const largeMessages = []
  let largeCursor = 205
  for (;;) {
    const page = await call('message.read', {
      actor: alice,
      roomId: room.id,
      afterSeq: largeCursor,
      limit: 50,
      waitMs: 0,
    })
    largeMessages.push(...page.messages)
    largeCursor = page.next_seq
    if (!page.has_more) break
  }
  assert.equal(largeMessages.length, 33)

  const partialSocket = createConnection(roomd.socketPath)
  await new Promise((resolve, reject) => {
    partialSocket.once('connect', resolve)
    partialSocket.once('error', reject)
  })
  partialSocket.write('{"id":"partial"')
  const firstClose = roomd.close()
  const secondClose = roomd.close()
  assert.equal(secondClose, firstClose)
  await Promise.race([
    firstClose,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('daemon close was blocked by a partial frame')), 500)),
  ])
  assert.equal(existsSync(roomd.socketPath), false)
})

test('startup publication failure closes the database and both listening servers', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-room-start-failure-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await import('node:fs/promises').then(({ mkdir }) => mkdir(join(dataDir, 'runtime.json')))

  await assert.rejects(
    startRoomDaemon({ dataDir }),
    error => ['EISDIR', 'EEXIST', 'EPERM'].includes(error?.code) || /runtime|rename|directory/i.test(error?.message),
  )
  assert.equal(existsSync(join(dataDir, 'roomd.sock')), false)
})

test('HTTP bind failure closes startup resources before returning', async t => {
  const blocker = createHttpServer((_request, response) => response.end('occupied'))
  await listen(blocker, 0, '127.0.0.1')
  t.after(() => close(blocker))
  const address = blocker.address()
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-room-http-collision-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  await assert.rejects(
    startRoomDaemon({ dataDir, httpPort: address.port }),
    error => error?.code === 'EADDRINUSE',
  )
  assert.equal(existsSync(join(dataDir, 'roomd.sock')), false)
})
