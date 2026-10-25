// Story 6.2 — the COMPRESSED VALIDATION of the REL-3 soak harness. The formal
// 8-hour run itself is launched separately, detached, by the human-or-chosen
// runner:
//
//     nohup node tests/soak/rel3-soak.mjs --duration-hours 8 > /tmp/rel3-soak.log 2>&1 &
//
// THIS test proves the harness MECHANICS work on a 5-minute compressed
// profile (docs/epics.md Story 6.2's AC, exercised at duration/96 scale):
// the runner materializes the release candidate and proves its identity
// under the candidate-immutability law, spawns the RC server child plus four
// concurrent MCP client children, runs the traffic profile (steady per-room
// cadence + bursts + the payload ramp toward the 32 KiB cap + reconnect
// cycles on the compressed schedule), samples RSS/FD through the Story 2.4
// harness, journals every ack to the external REL-2 recorder, drains and
// byte-verifies the full log at the end, evaluates the single pass rule over
// the final window (the total-growth bound — the final four hours are the
// final half of the wall duration), and lands both evidence files.
//
// What this test is NOT: it is not the endurance evidence. A 5-minute window
// cannot prove 8-hour FD/RSS stability; it proves the machinery that will
// is correct — identity, spawn patterns, traffic, recording, drainage, rule
// evaluation, and the outputs. The verdict recorded here is the compressed
// run's own verdict, judged by the same rules at their compressed scale.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runSoak } from './rel3-soak.mjs'

test('REL-3 compressed validation: the soak harness runs the candidate artifact green on a 5-minute compressed profile', async () => {
  // The evidence always lands OUTSIDE the repository (the release gate's own
  // discipline): the compressed run is harness validation, never a doc.
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-rel3-soak-validate-'))
  try {
    const outDir = join(parent, 'evidence')
    // developmentTree: the suite runs DURING v0.3 development, so the tree is
    // intentionally ahead of the shipped v0.2.0 candidate the frozen record
    // pins. This mode keeps every mechanic (including a determinism gate: a
    // second materialization must reproduce the digests) and records the
    // explicit development verdict; the release path's strict refusal is
    // untouched (runSoak without the flag still refuses a drifted candidate).
    const document = await runSoak({ durationMinutes: 5, outDir, developmentTree: true })

    // The run's own verdict, judged by the same rules at compressed scale.
    assert.equal(
      document.status,
      'pass',
      `the compressed soak must pass its own rules; failureReasons=${JSON.stringify(document.failureReasons)}`,
    )

    // Identity: the soak ran the RC artifact, not the repository tree, and
    // the candidate-immutability proof resolved (exact, runtime-pinned, or —
    // during v0.3 development only — the development-tree determinism gate).
    assert.ok(
      ['candidate-exact', 'runtime-pinned-docs-drift', 'development-tree-deterministic'].includes(document.candidate.identityVerdict),
      `the identity verdict must be an allowed pass verdict, received ${document.candidate.identityVerdict}`,
    )
    assert.ok(document.candidate.candidateCommit, 'the candidate commit is recorded')
    assert.ok(
      document.environment.serverEntry.includes('agent-room-agent-plugin'),
      'the server child ran from the MATERIALIZED portable artifact',
    )

    // The profile actually moved traffic through >=3 concurrent sessions.
    assert.equal(document.clients.length, 4, 'four concurrent client sessions ran')
    assert.equal(
      new Set(document.clients.map(client => client.fingerprint)).size,
      4,
      'the four clients carry four distinct keypairs',
    )
    assert.ok(
      document.traffic.acknowledged >= 500,
      `the compressed profile moved real traffic: ${document.traffic.acknowledged} acknowledged`,
    )
    assert.ok(document.traffic.bursts >= 5, `bursts ran: ${document.traffic.bursts}`)
    assert.ok(
      document.traffic.reconnects.length >= 3,
      `hourly reconnects ran on the compressed schedule: ${JSON.stringify(document.traffic.reconnects)}`,
    )
    assert.ok(document.traffic.reads > 0, 'the clients advanced cursors with reads')

    // The rules evaluated with the run's own numbers, and all passed (the
    // status assertion already gates this; these name the numbers).
    assert.equal(document.rules.finalWindowRss.pass, true, 'the final-window total-growth rule passed')
    assert.ok(document.rules.finalWindowRss.growthRatio <= 0.02, 'the endpoint growth is within the 2% bound')
    assert.ok(document.rules.finalWindowRss.impliedGrowthRatio <= 0.02, 'the regression-implied growth is within the 2% bound')
    assert.equal(document.rules.fdStability.pass, true, 'the FD corridor rule passed')
    assert.ok(document.rules.fdStability.worstAbsDrift <= 5, 'FD drift stayed within +-5 of the baseline')
    assert.equal(document.rules.zeroMessageLoss.pass, true, 'zero message loss passed')
    assert.equal(
      document.rules.zeroMessageLoss.ackedCount,
      document.rules.zeroMessageLoss.readableCount,
      'the acknowledged set equals the readable set (nothing lost, nothing phantom)',
    )
    assert.equal(document.rules.zeroMessageLoss.duplicates, 0, 'zero duplicated acks')

    // The REL-4 counter-metric was recorded (reported, not gated): the
    // 0-Actor idle floor at the start, in every reconnect window, and at
    // the end, plus the post-resume settled samples.
    assert.ok(document.idleFootprint.reported === true && document.idleFootprint.gated === false)
    const zeroActorSamples = document.idleFootprint.samples.filter(sample => sample.actors === 0)
    assert.ok(
      zeroActorSamples.length >= 3,
      `the 0-Actor idle floor was sampled at start/reconnects/end: ${zeroActorSamples.length} samples`,
    )
    for (const sample of document.idleFootprint.samples) {
      assert.ok(sample.rssBytes > 0 && Number.isSafeInteger(sample.fdCount) && Number.isFinite(sample.cpuSeconds))
    }

    // The sampler recorded real samples through the run.
    assert.ok(document.samples.count >= 20, `the tracker sampled the run: ${document.samples.count} samples`)
    assert.equal(document.samples.data.length, document.samples.count)

    // Both evidence files landed, and the JSON parses back to the same run.
    const jsonPath = join(outDir, 'v0.2.0-soak-results.json')
    const mdPath = join(outDir, 'v0.2.0-soak-results.md')
    assert.equal(existsSync(jsonPath), true, 'the machine-readable results file exists')
    assert.equal(existsSync(mdPath), true, 'the human-readable summary exists')
    for (const path of [jsonPath, mdPath]) {
      assert.equal(statSync(path).mode & 0o777, 0o600, `${path} is 0600`)
    }
    const reread = JSON.parse(readFileSync(jsonPath, 'utf8'))
    assert.equal(reread.status, 'pass')
    assert.equal(reread.traffic.acknowledged, document.traffic.acknowledged)
    assert.ok(reread.environment.node.startsWith('v24'), `the Node version is pinned and recorded: ${reread.environment.node}`)
    assert.ok(reread.environment.sqlite, `the SQLite version is pinned and recorded: ${reread.environment.sqlite}`)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
