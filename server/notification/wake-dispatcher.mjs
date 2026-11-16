// Story 3.2 — the two-phase wake dispatcher. Trust gate FIRST, then a single
// atomic Phase A reservation (BEGIN IMMEDIATE inside the scope ledger), then
// Phase B dispatch OUTSIDE any transaction, then Phase C CAS-commit to BOTH the
// ledger mirror and cursors.json v2 via the one cursor writer.
//
//   trust → reserve(seq > notified, lease expired, G1/G2 charge)
//         → dispatch()  [external; transaction already closed]
//         → success: CAS(owner) commit → advanceCursor(notified_seq)
//         → failure: release lease within <=2000 ms; notified_seq UNMOVED
//
// The dispatcher is transport-agnostic: `dispatch({candidate})` is injected.
// In THIS story the caller wires it to the existing `agent-room wait` long-poll
// (a completed wait process IS the wake); 3.3 swaps only that transport.
//
// HELD rows never reach the guard: `decideHeld` (the ratified 300 s / 10-per-60 s
// wake ledger) gates them, and a granted Held wake records a SUPPRESSED watermark
// ONLY. It never touches notified_seq and never charges G1/G2. Crucially the
// trusted gate reads notified_seq ALONE — a Held 10 cannot hide a Trusted 9.

import { advanceCursor } from '../client/cursors.mjs'

export function createWakeDispatcher({
  ledger,
  pluginDataDir,
  realmId,
  scope,
  classifyRow,
  decideHeld,
  advance = advanceCursor,
  now = () => Date.now(),
} = {}) {
  // Trust gate: the classifier is the ONLY authority on held vs trusted, and
  // it runs before any ledger read or reservation. Returns a normalized
  // candidate {room_id, seq, held, actor_fingerprint, verdict}.
  function gate(row) {
    const verdict = classifyRow(row)
    return {
      room_id: row?.room_id ?? verdict?.room_id,
      seq: row?.seq,
      held: verdict?.held === true,
      actor_fingerprint: verdict?.actor_fingerprint ?? row?.actor_fingerprint,
      verdict,
    }
  }

  // Dispatch one TRUSTED candidate through the two-phase protocol.
  // `dispatch` is injected and receives the reserved candidate.
  async function dispatchTrusted(candidate, { dispatch, local, peer, realmId: effectiveRealm = realmId } = {}) {
    const nowMs = now()
    // Phase A — reserve (atomic position/lease/guard check + charge).
    const reservation = ledger.reserve({
      realmId: effectiveRealm,
      roomId: candidate.room_id,
      seq: candidate.seq,
      local,
      peer,
      owner: undefined, // ledger mints one; returned on the reservation
      nowMs,
    })
    if (reservation.status === 'busy') {
      return { ok: false, action: 'skipped', reason: 'ledger_busy', detail: reservation.detail, diagnostics: ledger.drainDiagnostics() }
    }
    if (reservation.status === 'paused') {
      return { ok: false, action: 'paused', reason: reservation.reason, verdict: reservation.verdict, diagnostics: ledger.drainDiagnostics() }
    }
    if (reservation.status === 'skip') {
      return { ok: false, action: 'skipped', reason: reservation.reason, diagnostics: ledger.drainDiagnostics() }
    }
    const owner = reservation.owner

    // Phase B — external dispatch, transaction already COMMITted by reserve.
    let dispatched = false
    let dispatchError = null
    try {
      dispatched = (await dispatch({ candidate, reservation, nowMs })) !== false
    } catch (error) {
      dispatchError = error
      dispatched = false
    }
    if (!dispatched) {
      // Release the lease; notified_seq does NOT move; seq is retryable once.
      ledger.release({ roomId: candidate.room_id, seq: candidate.seq, owner })
      return {
        ok: false,
        action: 'released',
        reason: dispatchError ? dispatchError?.code ?? 'dispatch_failed' : 'dispatch_returned_false',
        message: dispatchError?.message ?? null,
        diagnostics: ledger.drainDiagnostics(),
      }
    }

    // Phase C — CAS commit to the ledger mirror (ownership check inside).
    const committed = ledger.commit({ roomId: candidate.room_id, seq: candidate.seq, owner, nowMs })
    if (committed.status !== 'committed') {
      return { ok: false, action: 'skipped', reason: `cas_${committed.status}`, diagnostics: ledger.drainDiagnostics() }
    }
    // The one notified_seq writer on cursors.json v2. The mirror is already
    // advanced; advanceCursor is monotonic so a concurrent writer cannot pull
    // it back. Its scope matches the ledger's scope.
    await advance(pluginDataDir, {
      realmId: effectiveRealm,
      roomId: candidate.room_id,
      seq: candidate.seq,
      field: 'notified_seq',
    }, { scope })
    return {
      ok: true,
      action: 'woke',
      room_id: candidate.room_id,
      seq: candidate.seq,
      verdict: reservation.verdict,
      diagnostics: ledger.drainDiagnostics(),
    }
  }

  // Dispatch one HELD candidate via the wake ledger's cooldown/budget only.
  // No loop ledger reserve, no G1/G2, no notified_seq; the suppressed watermark
  // is recorded separately so a later Trusted row is never hidden.
  function dispatchHeld(candidate) {
    const granted = decideHeld({
      fingerprint: candidate.actor_fingerprint ?? candidate.verdict?.actor_fingerprint,
    })
    if (granted === false) return { ok: false, action: 'held_suppressed' }
    // Record the Held watermark SEPARATELY — never max()-ed with notified_seq.
    const recorded = ledger.suppressHeld({ roomId: candidate.room_id, seq: candidate.seq })
    if (recorded.status === 'busy') {
      return { ok: false, action: 'skipped', reason: 'ledger_busy', detail: recorded.detail, diagnostics: ledger.drainDiagnostics() }
    }
    return { ok: true, action: 'woke_held', room_id: candidate.room_id, seq: candidate.seq }
  }

  // Evaluate a raw server row: trust gate first, then route trusted/held.
  async function evaluate(row, options) {
    const candidate = gate(row)
    if (candidate.held) return dispatchHeld(candidate)
    return dispatchTrusted(candidate, options)
  }

  return Object.freeze({ gate, dispatchTrusted, dispatchHeld, evaluate })
}

// Build the pause hint that `wait` prints locally (never posted to chat).
export function pauseHint(reason, peerSelector) {
  if (reason === 'global_limit') {
    return 'paused: global limit 25 reached; run agent-room wake-reset --all'
  }
  return `paused: pair limit 8 reached; run agent-room wake-reset --peer ${peerSelector ?? '<x>'}`
}
