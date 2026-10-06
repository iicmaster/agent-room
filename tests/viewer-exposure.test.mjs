// Story 5.3 acceptance — the remote exposure check: a viewer exposed beyond
// loopback gives NOTHING to anyone without the token, is writable by no one,
// and still works for the holder.
//
// The AC, verbatim (docs/epics.md): Given a viewer exposed on a non-loopback
// interface, When an unauthenticated request arrives from another host, Then
// it is refused; the viewer surface is GET-only and the viewer token never
// authorizes any API write.
//
// The drill runs REAL processes over the Story 4.7/4.8 TLS harness, reused:
// one real direct-launch server child (server/api/server.mjs) started
// through the strict topology env with AGENT_ROOM_HOST naming the machine's
// non-loopback IPv4 interface address (the tests/ensure-server.test.mjs
// discovery pattern) and AGENT_ROOM_TLS_CERT/KEY pointing at the same
// throwaway certificates those suites generated — spawned by one real driver
// child (tests/viewer-exposure-driver.mjs) running with
// NODE_EXTRA_CA_CERTS, so every dial rides Node's DEFAULT verification
// (chain via the private root's documented mechanism, hostname check fully
// on against the material's SAN name). No override exists anywhere.
//
// HONEST SCOPE (the 4.7/4.8 precedent restated): the automated proof is one
// host through real TLS whose only open door is the non-loopback interface —
// the driver probes the loopback door on the same port and it must refuse,
// so the drill's "requests from another host" genuinely arrive via the
// exposed interface; the literal physical cross-machine wire is Epic 6's
// REL-1. On a host with no non-loopback IPv4 address the drill is skipped
// (the ensure-server precedent: there is nothing to expose there).
//
// Drill row → test map (one driver run serves all three; the gate is judged
// twice, once inline in the driver and once here — the 4.8 discipline):
//    a  the non-loopback bind + the closed loopback door → the topology oracles (asserted in every test)
//    b  unauthenticated refusals, zero body previews     → 'an unauthenticated request over the non-loopback interface…'
//    c  GET-only + the token never authorizes a write    → 'the exposed viewer surface is GET-only…'
//    d  the holder's path + the no-secrets stderr        → 'the holder's path still works over the non-loopback interface…'

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import os from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// The same throwaway PKI material tests/self-hosting-deployment.test.mjs
// generated once for its suite (EC P-256, valid to 2126): a CA and a leaf
// with IP:127.0.0.1/DNS:localhost SANs — reused here byte-identically so the
// exposure drill proves itself against the same certificates the deployment
// and dress-rehearsal journeys used (zero new crypto, zero deps).
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DRIVER_ENTRY = join(ROOT, 'tests', 'viewer-exposure-driver.mjs')

// The established non-loopback discovery (tests/ensure-server.test.mjs): the
// first non-internal IPv4 address, or null when this host has none — in
// which case there is no interface to expose and the drill skips.
function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries ?? []) {
      if (!info.internal && info.family === 'IPv4') return info.address
    }
  }
  return null
}

// --- One driver run serves all three tests (the 4.7 journeyReport pattern) --

let exposureReportPromise = null

function exposureReport(t) {
  if (exposureReportPromise === null) exposureReportPromise = runDriver(t)
  return exposureReportPromise
}

async function runDriver(t) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-exposure-'))
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
      AGENT_ROOM_EXPOSURE_ROOT: join(parent, 'world'),
      AGENT_ROOM_EXPOSURE_CERT: certPath,
      AGENT_ROOM_EXPOSURE_KEY: keyPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', chunk => stdoutChunks.push(chunk))
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  const [code] = await once(child, 'exit')
  const stdout = Buffer.concat(stdoutChunks).toString('utf8')
  const stderr = Buffer.concat(stderrChunks).toString('utf8')
  assert.equal(code, 0, `the driver child failed (exit ${code}):\n${stderr}`)
  const reportLine = stdout.split('\n').find(lineText => lineText.startsWith('REPORT:'))
  assert.ok(reportLine, `no REPORT line in the driver stdout:\n${stdout}`)
  return JSON.parse(reportLine.slice('REPORT:'.length))
}

function skipWithoutLan(t) {
  if (lanAddress() !== null) return false
  t.diagnostic('no non-loopback IPv4 address on this host — the exposure drill needs one (the ensure-server precedent)')
  return true
}

// --- The drill (matrix rows b, c, d) ---------------------------------------------

test('an unauthenticated request over the non-loopback interface is refused with zero body previews across the whole exposed viewer surface', async t => {
  if (skipWithoutLan(t)) return
  const report = await exposureReport(t)

  // The drill's own topology: the requests genuinely rode the exposed
  // interface — it answers, and the loopback door on the same port refuses.
  assert.equal(report.topology.exposedDoorAnswered, true, 'the server answers on the non-loopback interface')
  assert.equal(report.topology.loopbackDoor, 'ECONNREFUSED', 'the loopback door is closed: the only open door is the non-loopback interface')
  assert.equal(report.topology.defaultVerifiedTls, true, 'every dial rode default TLS verification')

  // The whole viewer surface refuses the unauthenticated "another host": the
  // static shell, whitelisted assets, the boot descriptor, the auth bridge
  // (no credential, junk credential, well-formed wrong credential), the
  // Broadcast Room page BY ITS REAL ROOM ID, and the SSE stream.
  assert.ok(report.unauthenticated.rows.length >= 12, `the unauthenticated matrix ran (${report.unauthenticated.rows.length} rows)`)
  for (const row of report.unauthenticated.rows) {
    assert.equal(row.status, 401, `${row.label}: refused in the 401 family`)
    assert.equal(row.code, 'unauthorized', `${row.label}: the canonical coded refusal`)
  }
  // Zero body previews: no refusal carries message text, room or realm
  // names, presence, HTML, asset names, or the page cursors.
  assert.equal(report.unauthenticated.zeroPreviews, true, 'no refusal body previews anything')
  assert.ok(report.unauthenticated.previewMarkersChecked >= 10, 'the marker list is non-trivial')
  assert.equal(report.unauthenticated.noSetCookie, true, 'no refusal mints a credential')
})

test('the exposed viewer surface is GET-only and the viewer token never authorizes any API write', async t => {
  if (skipWithoutLan(t)) return
  const report = await exposureReport(t)

  // GET-only: every viewer route answers every non-GET method the frozen
  // table's coded 404 — never executed — five routes × four verbs.
  assert.ok(report.getOnly.rows.length >= 20, `the GET-only matrix ran (${report.getOnly.rows.length} rows)`)
  for (const row of report.getOnly.rows) {
    assert.equal(row.status, 404, `${row.label}: the non-GET method falls to the frozen table's 404`)
    assert.equal(row.code, 'route_not_found', `${row.label}: never executed`)
  }
  // The CORRECT token on the wrong method buys nothing either.
  assert.equal(report.getOnly.credentialedPost.status, 404, 'POST /viewer/auth with the correct token is still route_not_found')
  assert.equal(report.getOnly.credentialedPost.noSetCookie, true, 'the refused verb minted no credential')

  // The token as Bearer on every write-capable API route: the local
  // exchange, the session bind/rename/release, the direct open, the send.
  assert.ok(report.isolation.bearerRows.length >= 6, `the bearer matrix ran (${report.isolation.bearerRows.length} rows)`)
  for (const row of report.isolation.bearerRows) {
    assert.ok(row.status === 401 || row.status === 403, `${row.label}: refused in the 401/403 family (got ${row.status})`)
    assert.equal(row.code, 'unauthorized', `${row.label}: the credential is class-isolated`)
  }

  // The enrollment route: the token is not an invite in either spelling.
  const [enrollShape, enrollUnknown] = report.isolation.enrollRows
  assert.equal(enrollShape.status, 400, 'the token as invite_token dies at the shape gate')
  assert.equal(enrollShape.code, 'invalid_request', 'the shape refusal is coded')
  assert.equal(enrollUnknown.status, 403, 'a well-formed unknown invite beside the token is refused')
  assert.equal(enrollUnknown.code, 'invite_invalid', 'the unknown-invite refusal is coded')

  // The operator writes (trust set, invite mint, ban) are CLI-host commands
  // with NO HTTP surface at all (AR-13): the probed phantom paths 404 with
  // the token presented.
  assert.ok(report.isolation.phantomRows.length >= 4, `the phantom operator routes were probed (${report.isolation.phantomRows.length} rows)`)
  for (const row of report.isolation.phantomRows) {
    assert.equal(row.status, 404, `${row.label}: no such HTTP surface exists`)
    assert.equal(row.code, 'route_not_found', `${row.label}: route_not_found`)
  }

  // The one route that answers 200 to any well-formed key — the
  // privilegeless challenge — carries no session, and its nonce answers
  // not_enrolled to a fresh key's VALID signature: the viewer credential
  // minted zero authority.
  assert.equal(report.isolation.challenge.status, 200, 'the privilegeless challenge answers as designed')
  assert.equal(report.isolation.challenge.nonceIssued, true, 'a nonce rides the result')
  assert.equal(report.isolation.challenge.sessionCarried, false, 'no session rides the result')
  assert.equal(report.isolation.challenge.answerStatus, 403, 'the fresh key’s valid answer is refused')
  assert.equal(report.isolation.challenge.freshAnswerCode, 'not_enrolled', 'the viewer credential enrolled no one')

  // The viewer cookie is equally nothing on the API class.
  assert.ok(report.isolation.cookieRows.length >= 5, `the cookie matrix ran (${report.isolation.cookieRows.length} rows)`)
  for (const row of report.isolation.cookieRows) {
    assert.equal(row.status, 401, `${row.label}: the cookie is nothing on the API class`)
    assert.equal(row.code, 'unauthorized', `${row.label}: ${row.code}`)
  }

  // Nothing was written anywhere: the room still holds exactly the one
  // holders-only message, and no session was ever bound by the viewer
  // credential.
  assert.equal(report.writesDidNotHappen.broadcastBefore, 1, 'the drill started from one message')
  assert.equal(report.writesDidNotHappen.broadcastAfter, report.writesDidNotHappen.broadcastBefore, 'the write matrix wrote nothing')
  assert.deepEqual(report.writesDidNotHappen.presenceOnline, ['ExposureActor'], 'no phantom session ever appeared in presence')
})

test("the holder's path still works over the non-loopback interface: the token mints the cookie and sees the broadcast room, and the drill leaves no secrets", async t => {
  if (skipWithoutLan(t)) return
  const report = await exposureReport(t)

  // The positive control, on the same exposed interface the refusals ran
  // against: the correct token mints the cookie (the exact AC flags), the
  // cookie reads the boot descriptor, the static shell, the Broadcast Room
  // page carrying the holders-only message, and the live stream delivering
  // it — the holder sees everything the refusals withheld.
  assert.equal(report.holder.mintStatus, 200, 'the correct token mints the cookie over the exposed interface')
  assert.equal(report.holder.cookieFlags, true, 'the minted cookie carries the exact AC flags')
  assert.equal(report.holder.bootStatus, 200, 'the cookie reads the boot descriptor')
  assert.equal(report.holder.shellStatus, 200, 'the cookie reads the static shell')
  assert.equal(report.holder.pageStatus, 200, 'the cookie reads the Broadcast Room page')
  assert.equal(report.holder.holdersLineSeen, true, 'the holder sees the holders-only message')
  assert.equal(report.holder.streamStatus, 200, 'the holder stream opens')
  assert.equal(report.holder.streamPresenceSeen, true, 'the stream opens with presence')
  assert.equal(report.holder.streamMessageSeen, true, 'the message rides the stream')

  // No secrets in the server child's stderr across the whole drill — the
  // strongest form: the stderr is empty, so neither the viewer token nor any
  // cookie value can be in it.
  assert.equal(report.secrets.stderrEmpty, true, 'the server child wrote nothing to stderr over the whole drill')
  assert.equal(report.secrets.cleanOfViewerToken, true, 'the stderr holds no viewer token')
  assert.equal(report.secrets.cleanOfCookie, true, 'the stderr holds no cookie value')

  t.diagnostic(`Story 5.3 exposure drill: ${JSON.stringify({
    exposedInterface: report.host,
    unauthenticatedRows: report.unauthenticated.rows.length,
    getOnlyRows: report.getOnly.rows.length,
    bearerRows: report.isolation.bearerRows.length,
    cookieRows: report.isolation.cookieRows.length,
    phantomOperatorRows: report.isolation.phantomRows.length,
    writesDidNotHappen: report.writesDidNotHappen,
  })}`)
})
