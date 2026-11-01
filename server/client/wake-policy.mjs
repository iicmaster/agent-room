// The wake policy (Epic 10 decision, ratified by the operator 2026-11-01):
// the wake channel has no trust gate on FIRST contact — a stranger's held
// row wakes the agent once, so an open DM is still discovered — but REPEAT
// wakes from the same untrusted sender are cooled down, and the
// installation's held-row wakes obey an aggregate budget. This is the
// alarm-fatigue gate both advisor round-tables converged on
// (docs/implementation/reviews/epic-10-ddd-contexts-decision.md, point 5).
//
// Discipline:
//   - CLIENT-ONLY state: the cooldown ledger lives at
//     PLUGIN_DATA/realms/<realm>/wake-state.json (0600, atomic rename) —
//     the server never learns who this installation cools down (the same
//     client-side trust boundary as the allowlist).
//   - Only HELD rows are gated. Trusted senders wake always; own rows were
//     never wakeable.
//   - Suppressed rows are never consumed: the policy only gates the SIGNAL,
//     never the durable log or the held pipeline (message_read stays the
//     single authoritative read path).
//   - A failed state write never blocks a wake (the wake is the primary
//     outcome; the cooldown may then repeat once — the honest trade-off).
//   - Both wake substrates (the always-on notifier and the `agent-room
//     wait` CLI) share THIS module — one policy, one ledger format, two
//     consumers.

import { join } from 'node:path'

import {
  HELD_WAKE_BUDGET,
  HELD_WAKE_BUDGET_WINDOW_MS,
  HELD_WAKE_COOLDOWN_MS,
  REALM_KEY_PATTERN,
} from '../constants.mjs'
import { AgentRoomRuntimeError, atomicWriteJson, readJsonFile } from '../runtime.mjs'

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

export function wakeStatePath(pluginData, realmId) {
  if (typeof realmId !== 'string' || !REALM_KEY_PATTERN.test(realmId)) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'the agent-room realm id is not a safe key; refusing to build a wake-state path from it',
    )
  }
  return join(pluginData, 'realms', realmId, 'wake-state.json')
}

// One held-row wake decision. Returns true when the wake may fire (and
// records it), false when this sender is within its cooldown or the
// installation has spent its budget for the current window.
export function decideHeldWake({ statePath, fingerprint, policy, now = Date.now() }) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return false
  let perSender = {}
  let heldWakes = []
  try {
    const stored = readJsonFile(statePath)
    if (stored && typeof stored === 'object') {
      if (stored.perSender && typeof stored.perSender === 'object') {
        perSender = Object.fromEntries(
          Object.entries(stored.perSender).filter(([, ts]) => typeof ts === 'number'),
        )
      }
      if (Array.isArray(stored.heldWakes)) {
        heldWakes = stored.heldWakes.filter(ts => typeof ts === 'number')
      }
    }
  } catch {
    // a missing or unusable ledger means "no cooldowns yet"
  }
  const inWindow = heldWakes.filter(ts => now - ts < policy.windowMs)
  const last = perSender[fingerprint]
  const cooled = typeof last !== 'number' || now - last >= policy.cooldownMs
  if (!cooled || inWindow.length >= policy.budget) return false
  inWindow.push(now)
  perSender[fingerprint] = now
  try {
    atomicWriteJson(statePath, { version: 1, perSender, heldWakes: inWindow })
  } catch {
    // the wake outranks its own bookkeeping
  }
  return true
}
