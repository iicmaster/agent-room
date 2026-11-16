// Story 5.2 — AC1/AC3 evidence for the release-readiness qualification runner.
//
// Focused tests only (the PM owns the epic full-suite gate). Each test drives
// the real runQualifyCommand with injected prerequisites/cells so the matrix,
// gating, exit codes and receipt invalidation are proven deterministically —
// no full pipeline, no 1000-send burst, no full-suite sweep in this file.

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  parseQualifyArgs, runQualifyCommand,
} from '../server/cli/qualify-commands.mjs'

const CELL_NAMES = ['PREREQ', 'RECEIPT', 'SM-1', 'SM-2', 'SM-3', 'SM-C1', 'SM-C2', 'FULL-SUITE', 'PACKAGING']

function capture() {
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  let stdout = ''
  let stderr = ''
  output.on('data', chunk => { stdout += chunk })
  errorOutput.on('data', chunk => { stderr += chunk })
  return { output, errorOutput, get stdout() { return stdout }, get stderr() { return stderr } }
}

function tempReceiptDir() {
  return mkdtempSync(join(tmpdir(), 'ar-story52-receipt-'))
}

const okPrereq = {
  ok: true,
  reasons: [],
  candidate: { files: 20, bytes: 1000, sha256: 'a'.repeat(64) },
}

function stubCells(status = 'qualified') {
  return Object.fromEntries(CELL_NAMES.map(name => [
    name,
    { status, ...(status === 'qualified' ? {} : { reason: `${name} is ${status}` }) },
  ]))
}

// --- argv grammar ------------------------------------------------------------------
test('parseQualifyArgs: defaults, bounds, enums, remote pairing', () => {
  assert.deepEqual(parseQualifyArgs(['--sessions', '10', '--json']).options, {
    sessions: 10, json: true, remote: null, invite: null, harness: 'generic',
  })
  assert.ok(parseQualifyArgs(['--sessions', '0']).error)
  assert.ok(parseQualifyArgs(['--sessions', '1001']).error)
  assert.ok(parseQualifyArgs(['--sessions', '1.5']).error)
  assert.ok(parseQualifyArgs(['--harness', 'bogus']).error)
  assert.ok(parseQualifyArgs(['--remote', 'https://x']).error, 'remote needs invite')
  assert.ok(parseQualifyArgs(['--invite', 'ar_inv1_x']).error, 'invite needs remote')
  assert.ok(parseQualifyArgs(['--remote', 'http://x', '--invite', 't']).error, 'remote must be https')
  assert.ok(parseQualifyArgs(['--bogus']).error)
  assert.equal(parseQualifyArgs(['--sessions', '1000']).options.sessions, 1000)
})

// --- AC1: prerequisite gating + inconclusive semantics -----------------------------
test('missing prerequisite (nofile) -> inconclusive + exit 1, no pipeline', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'warn', limit: 4095, recommended: 4096, message: 'NOFILE=4095 (< 4096); raise with: ulimit -n 4096' }),
    profileFn: async () => ({ cpu: 'x' }),
    suiteFn: async () => { throw new Error('pipeline must not run') },
  })
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.status, 'inconclusive')
  const report = JSON.parse(cab.stdout)
  assert.equal(report.verdict, 'inconclusive')
  assert.equal(report.exit_code, 1)
  assert.match(report.cells.PREREQ.reason, /NOFILE=4095/)
  assert.equal(report.cells['SM-1'].status, 'inconclusive')
  assert.equal(report.cells['SM-2'].status, 'inconclusive')
})

test('Node/SQLite prerequisite failure -> inconclusive with a clear reason', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    runtimeAssert: () => { throw Object.assign(new Error('agent-room requires Node 24.15 or newer; found 24.10'), { code: 'node_version_unsupported' }) },
    profileFn: async () => ({}),
  })
  assert.equal(outcome.exitCode, 1)
  const report = JSON.parse(cab.stdout)
  assert.equal(report.verdict, 'inconclusive')
  assert.match(report.cells.PREREQ.reason, /Node 24\.15/)
})

// --- AC1: per-cell status + exit codes ---------------------------------------------
test('every cell qualified -> qualified + exit 0', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const cells = stubCells('qualified')
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}),
    profileFn: async () => ({ cpu: 'x' }),
    suiteFn: async () => cells['FULL-SUITE'],
    packagingFn: async () => cells.PACKAGING,
    // Override the four measured cells with stubs, keeping the row set honest.
    ...stubOverrides(cells),
  })
  assert.equal(outcome.exitCode, 0)
  const report = JSON.parse(cab.stdout)
  assert.equal(report.verdict, 'qualified')
  assert.equal(report.exit_code, 0)
  assert.deepEqual(Object.keys(report.cells).sort(), [...CELL_NAMES].sort())
  for (const name of CELL_NAMES) assert.equal(report.cells[name].status, 'qualified', name)
})

test('one failed cell -> failed + exit 1 (no retry)', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const cells = stubCells('qualified')
  cells['SM-1'] = { status: 'failed', reason: 'round 2 breached the threshold' }
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}),
    profileFn: async () => ({}),
    suiteFn: async () => cells['FULL-SUITE'],
    packagingFn: async () => cells.PACKAGING,
    ...stubOverrides(cells),
  })
  assert.equal(outcome.exitCode, 1)
  const report = JSON.parse(cab.stdout)
  assert.equal(report.verdict, 'failed')
  assert.equal(report.cells['SM-1'].status, 'failed')
  assert.equal(report.cells['SM-1'].reason, 'round 2 breached the threshold')
})

test('one inconclusive cell -> inconclusive + exit 1', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const cells = stubCells('qualified')
  cells.PACKAGING = { status: 'inconclusive', reason: 'no claude binary' }
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}),
    profileFn: async () => ({}),
    suiteFn: async () => cells['FULL-SUITE'],
    packagingFn: async () => cells.PACKAGING,
    ...stubOverrides(cells),
  })
  assert.equal(outcome.exitCode, 1)
  assert.equal(JSON.parse(cab.stdout).verdict, 'inconclusive')
})

// --- AC3: receipt invalidation on candidate change ---------------------------------
test('changed candidate sha256 invalidates the prior receipt -> failed + exit 1', async () => {
  const dir = tempReceiptDir()
  writeFileSync(join(dir, 'qualify-receipt.json'), JSON.stringify({ sha256: 'deadbeef', verdict: 'qualified' }))
  const cab = capture()
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    profileFn: async () => ({}),
  })
  assert.equal(outcome.exitCode, 1)
  const report = JSON.parse(cab.stdout)
  assert.equal(report.verdict, 'failed')
  assert.equal(report.cells.RECEIPT.status, 'failed')
  assert.match(report.cells.RECEIPT.reason, /prior receipt sha256=deadbeef/)
  assert.match(report.cells.RECEIPT.reason, /current sha256=[0-9a-f]{64}/)
  assert.equal(report.receipt.previous_sha256, 'deadbeef')
})

test('a matching candidate receipt is not invalidated', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const cells = stubCells('qualified')
  // First run writes a receipt for whatever the real candidate sha256 is.
  await runQualifyCommand(['--json'], {
    output: new PassThrough(), errorOutput: new PassThrough(), pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}), profileFn: async () => ({}),
    suiteFn: async () => cells['FULL-SUITE'], packagingFn: async () => cells.PACKAGING,
    ...stubOverrides(cells),
  })
  const { readFileSync } = await import('node:fs')
  const stored = JSON.parse(readFileSync(join(dir, 'qualify-receipt.json'), 'utf8'))
  assert.equal(typeof stored.sha256, 'string')
  const cab2 = capture()
  await runQualifyCommand(['--json'], {
    output: cab2.output, errorOutput: cab2.errorOutput, pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}), profileFn: async () => ({}),
    suiteFn: async () => cells['FULL-SUITE'], packagingFn: async () => cells.PACKAGING,
    ...stubOverrides(cells),
  })
  const report = JSON.parse(cab2.stdout)
  assert.notEqual(report.cells.RECEIPT.status, 'failed')
  assert.equal(report.receipt.invalidated, false)
})

// The measured cells (SM-1, SM-2, SM-3, negatives) are intentionally NOT
// stubbed in a way that hides their thresholds — these tests inject them via
// the seams below and assert the aggregate verdict; the real measurement path
// is exercised by `agent-room qualify --json` (reported separately to the PM).
function stubOverrides(cells) {
  return {
    sm1Fn: async () => cells['SM-1'],
    sm2Fn: async () => cells['SM-2'],
    sm3Fn: async () => cells['SM-3'],
    negativesFn: async () => ({
      status: cells['SM-C1'].status,
      reason: cells['SM-C1'].reason,
      checks: [
        { check: 'loop_pause_and_wake_reset', status: cells['SM-C1'].status },
        { check: 'allowlist_leak_canary', status: cells['SM-C2'].status, leaks: 0, scanned: 3 },
      ],
    }),
  }
}
