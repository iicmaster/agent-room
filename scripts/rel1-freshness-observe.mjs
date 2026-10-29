#!/usr/bin/env node
// REL-1 freshness observer — the Operator Flight Kit's reusable measurement
// (Story 7.5, retro action A4: the measurement the REL-1 AC asks for is no
// longer re-invented per run). Two modes:
//
//   snippet   prints the browser observer to paste into the viewer's
//             DevTools console (the MutationObserver that records each
//             message card's first-appearance instant, per sequence).
//
//   compute   reads a raw measurement JSON (the four canary epoch numbers
//             plus the two measured Date-header offset medians) from
//             --input <file>, recomputes the freshness figures through the
//             ONE shared arithmetic module (scripts/rel1-freshness.mjs),
//             and writes the freshness.json evidence file (0600) to --out.
//             The evidence verifier later RECOMPUTES this file with the
//             same module — arithmetic drift between capture and
//             verification is a failure by construction.
//
// Exit codes: 0 wrote/printed; 1 bad input or a bound violation; 2 usage.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFreshnessDocument } from './rel1-freshness.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))

const SNIPPET = `// agent-room REL-1 freshness observer — paste into the VIEWER page's DevTools
// console (the authenticated viewer tab), then run the demo. It records the
// wall-clock instant each broadcast message card FIRST appears (one per
// sequence: a catch-up card and its live twin count once), keeps the log on
// the window for the operator to copy into the measurement input, and never
// sends anything anywhere.
(() => {
  if (window.__agentRoomFreshness) return window.__agentRoomFreshness;
  const arrivals = new Map();
  const record = (seq, text) => {
    if (seq === null || seq === undefined || arrivals.has(seq)) return;
    arrivals.set(seq, { seq: Number(seq), text: String(text ?? '').slice(0, 200), dom_arrival_epoch_ms: Date.now() });
  };
  const watch = (list) => {
    for (const node of list) {
      if (!(node instanceof HTMLElement)) continue;
      for (const card of [node, ...node.querySelectorAll('[data-seq], .message, .card')]) {
        const seq = card.dataset?.seq ?? card.getAttribute?.('data-seq');
        if (seq !== undefined && seq !== null) record(seq, card.textContent);
      }
    }
  };
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) watch(mutation.addedNodes);
  });
  const mount = document.querySelector('[data-messages], .messages, main, body');
  observer.observe(mount ?? document.body, { childList: true, subtree: true });
  document.querySelectorAll('[data-seq], .message, .card').forEach(card => {
    const seq = card.dataset?.seq ?? card.getAttribute?.('data-seq');
    if (seq !== undefined && seq !== null) record(seq, card.textContent);
  });
  window.__agentRoomFreshness = {
    arrivals,
    dump: () => JSON.stringify([...arrivals.values()].sort((a, b) => a.seq - b.seq), null, 2),
  };
  console.log('agent-room freshness observer armed; copy window.__agentRoomFreshness.dump() after the canaries land.');
  return window.__agentRoomFreshness;
})();
`

function usage() {
  process.stderr.write([
    'usage: node scripts/rel1-freshness-observe.mjs snippet',
    '       node scripts/rel1-freshness-observe.mjs compute --input <measurement.json> --out <freshness.json>',
    '',
    'The measurement input carries the raw numbers only (the shared module',
    'computes every derived figure):',
    '',
    '{ "same_clock_measurement": { "sendAckedEpochMs": 1792587163320,',
    '    "domArrivalEpochMs": 1792587163470, "seq": 3, "text": "REL1-FRESH-MAC-…",',
    '    "sender": "…", "senderClock": "…" },',
    '  "cross_machine_measurement": { "sendAckedEpochMs": …, "domArrivalEpochMs": …,',
    '    "viewerClock": "…", "sender": "…", "senderClock": "…",',
    '    "macOffsetMs": 485, "stagingOffsetMs": 589, "offsetSamplesPerClient": 9,',
    '    "seq": 4, "text": "REL1-FRESH-STAGING-…" } }',
    '',
    'The two offsets are the Date-header medians measured per client',
    '(9 samples each): median(client midpoint - server epoch).',
  ].join('\n'))
  process.exit(2)
}

function fail(message) {
  process.stderr.write(`rel1-freshness-observe: ${message}\n`)
  process.exit(1)
}

const [mode, ...rest] = process.argv.slice(2)
if (mode === 'snippet') {
  process.stdout.write(SNIPPET)
  process.exit(0)
}
if (mode !== 'compute') usage()

let inputPath = null
let outPath = null
for (let index = 0; index < rest.length; index += 2) {
  if (rest[index] === '--input') inputPath = rest[index + 1]
  else if (rest[index] === '--out') outPath = rest[index + 1]
  else usage()
}
if (!inputPath || !outPath) usage()

let document_
try {
  document_ = buildFreshnessDocument(JSON.parse(readFileSync(resolve(process.cwd(), inputPath), 'utf8')))
} catch (error) {
  fail(`the measurement input is invalid: ${error.message}`)
}
const boundFail = document_.same_clock_measurement.verdict.startsWith('fail')
  || document_.cross_machine_measurement.verdict.startsWith('fail')
const destination = resolve(process.cwd(), outPath)
writeFileSync(destination, `${JSON.stringify(document_, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`wrote ${destination}\n`)
process.stdout.write(`  same-clock:    ${document_.same_clock_measurement.freshness_seconds} s\n`)
process.stdout.write(`  cross-machine: ${document_.cross_machine_measurement.corrected_freshness_seconds} s (corrected)\n`)
if (boundFail) {
  fail('a measurement exceeded the 5 s bound — the evidence file was written with the failing verdicts; see the runbook before proceeding')
}
process.exit(0)
