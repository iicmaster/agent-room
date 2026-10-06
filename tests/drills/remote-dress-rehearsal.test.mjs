// Story 4.8 acceptance — the remote dress rehearsal: Epic 4's BLOCKING exit
// gate (ruling Q3). The parent spawns one real driver child
// (tests/drills/remote-dress-rehearsal-driver.mjs) with NODE_EXTRA_CA_CERTS
// pointing at the same test CA the Story 4.7 deployment suite generated, and
// the driver walks the whole gate:
//
//   1. Two identity sandboxes (dressA, dressB — distinct Ed25519 keypairs)
//      exercise the real remote protocol over HTTPS through a real TLS front
//      terminating to a loopback plaintext backend server child. `/api/auth/
//      local` is FORBIDDEN in this drill, and the counted wire scan (every
//      request on both legs, bodies and credential headers included) proves
//      zero local-token requests and zero local-token bytes.
//   2. The full governance flow executes: the operator mints an invite
//      through the CLI host → enroll A (the real `remote enroll` dispatch,
//      then the challenge lane) → a second use of the SAME invite fails
//      coded invite_exhausted → enroll B (a SECOND invite) → A/B exchange
//      DMs and broadcasts through the declared-default rate gates (paced at
//      2/s so the 0.5/s send bucket drains visibly and never empties), one
//      explicit probe bursts past the bucket capacity and asserts
//      rate_limited with retry_after_ms before backing off and succeeding →
//      the operator bans B by fingerprint through the CLI host → B's sends
//      and long-polls are refused `banned` at next request, the in-flight
//      long-poll terminating at its next wake inside the 20 s window.
//   3. Multi-client connection churn under remote HTTPS (Epic 4's churn
//      extension per ruling Q4): 100 connect/auth/bind/disconnect cycles for
//      TWO enrolled clients over the TLS front, the server's FD count held
//      within ±5 of its post-warmup baseline through the Story 2.4 leak
//      tracker (the front's own FDs held to the same corridor), the server's
//      TCP inventory reduced to exactly its one listener, and zero leaked
//      live sessions.
//
// The parent re-asserts every headline oracle from the driver's REPORT — the
// gate is judged twice, once inline in the child and once here. HONEST SCOPE
// (the 4.7 precedent restated): the automated proof is loopback through real
// TLS; the physical cross-machine wire is Epic 6's REL-1. The drill rides
// the api-client (the MCP adapter's own transport) and the raw frozen
// protocol; the tool-boundary trust matrix and held pipeline are Story
// 3.2/3.3/3.5's surface and are not re-proved here.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// The same throwaway PKI material tests/self-hosting-deployment.test.mjs
// generated once for its suite (EC P-256, valid to 2126): a CA and a leaf
// with IP:127.0.0.1/DNS:localhost SANs. Reused here so the dress rehearsal
// proves itself against the same certificates the deployment journeys used —
// zero new crypto, zero deps.
const TEST_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIBojCCAUegAwIBAgIUD2mVO92poUKwIEasdTszkKpozkwwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSYWdlbnQtcm9vbSB0ZXN0IENBMCAXDTI2MDkyOTEzNDIyNVoY
DzIxMjYwOTA1MTM0MjI1WjAdMRswGQYDVQQDDBJhZ2VudC1yb29tIHRlc3QgQ0Ew
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASgVzvUD5OUUZeLFAjEheROAdVeglM2
HvD9nLsxO1McBPUgcY7+kMUVUaj3UfDVyXCFehWBSv/ceYqJAUgLP6iBo2MwYTAd
BgNVHQ4EFgQUH6+1soSK0M6O3+mzCYboePFUIUAwHwYDVR0jBBgwFoAUH6+1soSK
0M6O3+mzCYboePFUIUAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAgQw
CgYIKoZIzj0EAwIDSQAwRgIhAO/BNPj39MSrRZ/TPU6YL2Ut7fm4F22j8b0tFvlp
Ea8tAiEAu6u1cVyOYtS1C2CzvREWDgzPRNwJecRiZisNCClyqOM=
-----END CERTIFICATE-----
`

const TEST_LEAF_CERT = `-----BEGIN CERTIFICATE-----
MIIBbDCCAROgAwIBAgIUXOwXSVxeSh+6HT1h+2+z0KpY+UgwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSYWdlbnQtcm9vbSB0ZXN0IENBMCAXDTI2MDkyOTEzNDIyNVoY
DzIxMjYwOTA1MTM0MjI1WjAjMSEwHwYDVQQDDBhhZ2VudC1yb29tIGxvb3BiYWNr
IGxlYWYwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATQ3AsMwxRYz5RKY0951dBd
DCWFfG4LU6FnsBFhZhXHe9ZpvFylTFzxlI0xurS71FzDc93/mK8C4j1Bq5Sihntb
oykwJzAaBgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwCQYDVR0TBAIwADAKBggq
hkjOPQQDAgNHADBEAiAk0GyO4d1Z3YrxFL0IaOUJSfIQZMQGG9l9IEm+F57BrwIg
bCzW4Rc1O/JuhIqlQuVX+OdtS0+XREGjSBhl2pMOL+M=
-----END CERTIFICATE-----
`

const TEST_LEAF_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgNYZzhGf/0QoEHqrZ
XPcK/H+WmhZJVCi7p6sof36zyq2hRANCAATQ3AsMwxRYz5RKY0951dBdDCWFfG4L
U6FnsBFhZhXHe9ZpvFylTFzxlI0xurS71FzDc93/mK8C4j1Bq5Sihntb
-----END PRIVATE KEY-----
`

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DRIVER_ENTRY = join(ROOT, 'tests', 'drills', 'remote-dress-rehearsal-driver.mjs')

test('the remote dress rehearsal: two identity sandboxes run the full governance flow over real TLS with zero local-token requests, and multi-client churn holds the FD corridor with zero leaks', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-dress-'))
  chmodSync(parent, 0o700)
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const certsDir = join(parent, 'certs')
  mkdirSync(certsDir, { mode: 0o700 })
  const caPath = join(certsDir, 'ca.pem')
  const certPath = join(certsDir, 'leaf-cert.pem')
  const keyPath = join(certsDir, 'leaf-key.pem')
  writeFileSync(caPath, TEST_CA_CERT, { mode: 0o600 })
  writeFileSync(certPath, TEST_LEAF_CERT, { mode: 0o600 })
  writeFileSync(keyPath, TEST_LEAF_KEY, { mode: 0o600 })

  const child = spawn(process.execPath, [DRIVER_ENTRY], {
    env: {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'C.UTF-8',
      NODE_EXTRA_CA_CERTS: caPath,
      AGENT_ROOM_DRESS_ROOT: join(parent, 'world'),
      AGENT_ROOM_DRESS_CERT: certPath,
      AGENT_ROOM_DRESS_KEY: keyPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', chunk => stdoutChunks.push(chunk))
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  const [code] = await once(child, 'exit')
  const stdout = Buffer.concat(stdoutChunks).toString('utf8')
  const stderr = Buffer.concat(stderrChunks).toString('utf8')
  assert.equal(code, 0, `the driver child failed (exit ${code}):\n${stderr}`)
  const reportLine = stdout.split('\n').find(lineText => lineText.startsWith('REPORT:'))
  assert.ok(reportLine, `no REPORT line in the driver stdout:\n${stdout}`)
  const report = JSON.parse(reportLine.slice('REPORT:'.length))
  const { governance, churn, wire } = report

  // --- AC 1: the real remote protocol over HTTPS, local auth forbidden -------
  assert.equal(wire.localAuthRequests, 0, 'the counted scan proves zero /api/auth/local requests on the wire')
  assert.equal(wire.localTokenOnWire, false, 'the counted scan proves zero local-token bytes on the wire')
  assert.deepEqual(governance.transports, ['remote', 'remote'], 'both governance clients ride the earned challenge lane')
  assert.equal(governance.fingerprintsDistinct, true, 'the identity sandboxes carry distinct keypairs')
  assert.equal(wire.enrollHttps, 5, 'exactly five enroll presentations rode the wire')
  assert.ok(wire.httpsHops > 0, 'the clients rode real https legs')
  assert.ok(wire.httpHops > 0, 'the front proxied each request onto the loopback plaintext backend')

  // --- AC 2: the full governance flow -----------------------------------------
  for (const chatId of ['dressA', 'dressB', 'dressC', 'dressD']) {
    const receipt = governance.enrollReceipts[chatId]
    assert.equal(receipt?.enrolled, true, `${chatId}: the enroll receipt says enrolled`)
    assert.equal(receipt?.fingerprintMatches, true, `${chatId}: the receipt fingerprint is the installation's own key`)
    assert.equal(receipt?.serverUrl, governance.origin, `${chatId}: the receipt names the drill origin`)
  }
  assert.equal(governance.secondUse.refused, true, 'a second use of the same invite is refused')
  assert.equal(governance.secondUse.code, 'invite_exhausted', 'the second-use refusal is coded invite_exhausted')
  assert.equal(governance.spentInviteUsesRemaining, 0, 'the spent invite shows zero uses remaining')
  assert.equal(governance.dm.roomConverged, true, 'the DM pair room converged')
  assert.equal(governance.dm.count, 10, 'ten DMs exchanged through the rate gates')
  assert.equal(governance.dm.envelopeOnForeign, true, 'foreign DMs arrive inside the untrusted envelope')
  assert.equal(governance.broadcast.beforeProbe, 8, 'eight broadcasts exchanged through the rate gates')
  assert.ok(governance.probe.burst > 10, 'the probe burst exceeded the declared capacity')
  assert.ok(governance.probe.committed >= 8, `the burst committed against a settled bucket (${governance.probe.committed})`)
  assert.ok(governance.probe.refused >= 2, `the burst tripped the send bucket (${governance.probe.refused} refused)`)
  assert.equal(wire.rateLimitedResponses, governance.probe.refused * 2, 'every refusal is visible on both wire legs')
  assert.ok(wire.retryAfterMsSample >= 1, `the rate_limited refusals carry retry_after_ms (${wire.retryAfterMsSample})`)
  assert.equal(governance.probe.backoffCommitted, true, 'after the backoff the send succeeds')
  assert.equal(governance.ban.receiptOk, true, 'the operator ban succeeded through the CLI host')
  assert.equal(governance.ban.longPollRefused, 'banned', 'the mid-hold long-poll terminated with banned')
  assert.ok(governance.ban.longPollElapsedMs < governance.ban.longPollWindowMs, `the long-poll terminated within its window (${governance.ban.longPollElapsedMs} ms)`)
  assert.equal(governance.ban.sendRefused, 'banned', 'B\u2019s send is refused banned at next request')
  assert.equal(governance.ban.admissionRefused, 'banned', 'B\u2019s fresh long-poll is refused banned at admission')
  assert.equal(governance.ban.aUnaffected, 'committed', 'A is unaffected by B\u2019s ban')
  assert.equal(governance.ban.historyKept, true, 'the ban never touches history')

  // --- AC 3: multi-client churn over the TLS front with zero leaks ------------
  assert.equal(churn.cycles, 100, 'one hundred churn cycles ran')
  assert.equal(churn.clientsPerCycle, 2, 'two clients cycled per cycle (multi-client churn)')
  assert.equal(churn.completed, 200, 'every cycle for both clients completed')
  assert.ok(churn.fdSamples >= 12, `the FD corridor was sampled through the tracker (${churn.fdSamples} samples)`)
  assert.ok(churn.fdWorstDrift <= 5, `the server's FD count held the ±5 corridor (worst drift ${churn.fdWorstDrift} from baseline ${churn.fdBaseline})`)
  assert.ok(churn.selfFdDrift <= 5, `the front's FD count held the ±5 corridor (drift ${churn.selfFdDrift} from baseline ${churn.selfFdBaseline})`)
  assert.equal(churn.tcpListeningCount, 1, 'the server holds exactly one LISTEN socket after the churn')
  assert.equal(churn.tcpAllEqualsListener, true, 'zero leaked connection sockets')
  assert.equal(typeof churn.healthVersion === 'string' && churn.healthVersion.length > 0, true, 'the post-churn health answered through the front')
  assert.deepEqual(churn.presenceOnline, ['dressA', 'dressB', 'dressC'], 'zero churn sessions leaked into presence')

  t.diagnostic(`Story 4.8 dress rehearsal: ${JSON.stringify({
    governance: {
      probe: governance.probe,
      ban: { longPollElapsedMs: governance.ban.longPollElapsedMs, admissionMs: governance.ban.admissionMs, broadcastFinal: governance.ban.broadcastFinal },
    },
    churn: { fdBaseline: churn.fdBaseline, fdWorstDrift: churn.fdWorstDrift, selfFdBaseline: churn.selfFdBaseline, selfFdDrift: churn.selfFdDrift },
    wire: { captures: wire.captures, httpsHops: wire.httpsHops, httpHops: wire.httpHops, retryAfterMsSample: wire.retryAfterMsSample },
  })}`)
})
