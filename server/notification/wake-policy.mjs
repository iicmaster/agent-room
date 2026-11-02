// The wake policy (Epic 10 decision, ratified by the operator 2026-11-01):
// the wake channel has no trust gate on FIRST contact — a stranger's held
// row wakes the agent once, so an open DM is still discovered — but REPEAT
// wakes from the same untrusted sender are cooled down, and the
// installation's held-row wakes obey an aggregate budget. This is the
// alarm-fatigue gate both advisor round-tables converged on
// (docs/implementation/reviews/epic-10-ddd-contexts-decision.md, point 5).
//
// Discipline:
//   - CLIENT-ONLY state: the ledger lives under
//     PLUGIN_DATA/realms/<realm>/wake-ledger.sqlite — the server never learns
//     who this installation cools down (the same client-side trust boundary as
//     the allowlist).
//   - Only HELD rows are gated. Trusted senders wake always; own rows were
//     never wakeable.
//   - Suppressed rows are never consumed: the policy only gates the SIGNAL,
//     never the durable log or the held pipeline (message_read stays the
//     single authoritative read path).
//   - Both wake substrates (the always-on notifier and the `agent-room wait`
//     CLI) share THIS module — one policy, one ledger, two consumers.
//
// The storage behind it moved from a JSON file to SQLite on 2026-11-02; the
// read-modify-write race that motivated the move is documented in
// server/notification/wake-ledger.mjs together with the failure posture.

import {
  HELD_WAKE_BUDGET,
  HELD_WAKE_BUDGET_WINDOW_MS,
  HELD_WAKE_COOLDOWN_MS,
} from '../constants.mjs'

import { createWakeLedger, wakeLedgerPath } from './wake-ledger.mjs'

const positiveInt = (value, fallback) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

// The policy: defaults from the constants, tunable per installation via env
// (validated; a junk value falls back to the default rather than disabling
// the gate silently in the dangerous direction).
export function loadWakePolicy(env = process.env) {
  return {
    cooldownMs: positiveInt(env?.AGENT_ROOM_WAKE_COOLDOWN_MS, HELD_WAKE_COOLDOWN_MS),
    budget: positiveInt(env?.AGENT_ROOM_WAKE_BUDGET, HELD_WAKE_BUDGET),
    windowMs: positiveInt(env?.AGENT_ROOM_WAKE_BUDGET_WINDOW_MS, HELD_WAKE_BUDGET_WINDOW_MS),
  }
}

// Kept for callers that only need the realm's state directory.
export function wakeStatePath(pluginData, realmId) {
  return wakeLedgerPath(pluginData, realmId)
}

// One ledger per (pluginData, realm) per process: the connection carries the
// busy timeout and the schema check, and re-opening it per decision would pay
// for both on every row.
const ledgers = new Map()

function ledgerFor(pluginData, realmId, policy) {
  const key = `${pluginData}\u0000${realmId}`
  let ledger = ledgers.get(key)
  if (!ledger) {
    ledger = createWakeLedger({ pluginData, realmId, policy })
    ledgers.set(key, ledger)
  }
  return ledger
}

// One held-row wake decision. Returns true when the wake may fire (and
// records it), false when this sender is within its cooldown or the
// installation has spent its budget for the current window.
export function decideHeldWake({ pluginData, realmId, fingerprint, policy, now = Date.now() }) {
  return ledgerFor(pluginData, realmId, policy).decide(fingerprint, now)
}
