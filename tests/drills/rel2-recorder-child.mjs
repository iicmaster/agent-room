// REL-2 external ack recorder (Story 2.5) — a separate Node process, never
// the server. While the kill-drill's traffic flows, the drill reports every
// acknowledged send to this process as one line-delimited JSON record:
//
//   {"room_id": "...", "seq": 12, "client_message_id": "rel2-alice-42-..."}
//
// This process appends each record to its own log file — a file the Room
// Server never touches — so the acknowledged-set survives every server
// SIGKILL by definition: the recorder holds no state in the server's data
// directory, opens no socket, and never dies when the server does. After the
// final cycle the drill reads this file back as the oracle for "nothing
// lost, nothing phantom": every recorded (room, seq, client_message_id) must
// be readable from the restarted server, the readable set must equal it in
// size, and no client_message_id may appear twice (idempotency = zero
// duplicates).
//
// The recorder is deliberately strict about record shape: a malformed line is
// a loud exit (code 2), never a silent skip — an oracle that swallows garbage
// would be an oracle that can be lied to. Records are flushed to the OS with
// one write(2) each (survives this process crashing) and fsync(2)'d before
// exit (survives the machine).

import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'

const logPath = process.argv[2]
if (typeof logPath !== 'string' || logPath.length === 0) {
  process.stderr.write('usage: rel2-recorder-child.mjs <ack-log-path>\n')
  process.exit(1)
}

const RECORD_KEYS = ['client_message_id', 'room_id', 'seq']

const fd = openSync(logPath, 'a', 0o600)
let recordCount = 0
let buffer = ''

function record(line) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    process.stderr.write(`rel2-recorder: malformed ack line: ${JSON.stringify(line)}\n`)
    process.exit(2)
  }
  if (
    parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== RECORD_KEYS.join(',')
    || typeof parsed.room_id !== 'string' || parsed.room_id.length === 0
    || !Number.isSafeInteger(parsed.seq) || parsed.seq < 1
    || typeof parsed.client_message_id !== 'string' || parsed.client_message_id.length === 0
  ) {
    process.stderr.write(`rel2-recorder: ack record carries not exactly {client_message_id, room_id, seq>0}: ${JSON.stringify(parsed)}\n`)
    process.exit(2)
  }
  writeSync(fd, `${JSON.stringify(parsed)}\n`)
  recordCount += 1
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline === -1) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.length > 0) record(line)
  }
})
process.stdin.once('end', () => {
  if (buffer.length > 0) record(buffer)
  buffer = ''
  try {
    fsyncSync(fd)
    closeSync(fd)
  } catch (error) {
    process.stderr.write(`rel2-recorder: could not flush the ack log: ${error.message}\n`)
    process.exit(2)
  }
  process.stdout.write(`rel2-recorder: recorded ${recordCount} acknowledged send(s) to ${logPath}\n`)
  process.exit(0)
})
process.stdin.once('error', error => {
  process.stderr.write(`rel2-recorder: stdin failed: ${error.message}\n`)
  process.exit(2)
})
