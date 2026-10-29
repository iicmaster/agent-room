// REL-1 freshness arithmetic — the ONE implementation both the flight-kit
// observer (scripts/rel1-freshness-observe.mjs) and the evidence verifier
// (scripts/rel1-verify-evidence.mjs) share (Story 7.5, retro actions A4 +
// A10: the measurement is no longer re-invented per run, and the verifier
// RECOMPUTES it instead of grepping for it).
//
// The measured interval is sender-acknowledgement → DOM card insertion: the
// sender records the instant the server acknowledged its send (its own
// clock, immediately after the committed answer); the viewer's
// MutationObserver records the wall-clock instant each message card FIRST
// appears. It is an operational proxy, NOT a latency SLA — the
// acknowledgement is after the commit and the observer fires before the
// paint, so the interval is not the whole user-perceived latency.

export const FRESHNESS_BOUND_SECONDS = 5

// The raw inputs arrive camelCase from the observer CLI and snake_case in
// the recorded document — one normalizer, so the verifier recomputes the
// recorded file with the exact same code path.
const pick = (source, camel, snake) => {
  const value = source?.[camel] ?? source?.[snake]
  return value
}

const epochMs = (value, label) => {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite epoch-millisecond number`)
  }
  return value
}

// The same-clock measurement: sender and viewer are one machine, so the
// difference carries NO clock-skew term at all.
export function computeSameClock(input) {
  const sendAckedEpochMs = pick(input, 'sendAckedEpochMs', 'send_acked_epoch_ms')
  const domArrivalEpochMs = pick(input, 'domArrivalEpochMs', 'dom_arrival_epoch_ms')
  const { seq, text, sender, senderClock } = input ?? {}
  const send = epochMs(sendAckedEpochMs, 'sendAckedEpochMs')
  const arrival = epochMs(domArrivalEpochMs, 'domArrivalEpochMs')
  const freshnessMs = arrival - send
  if (freshnessMs < 0) {
    throw new Error('domArrivalEpochMs precedes sendAckedEpochMs: the same-clock interval cannot be negative')
  }
  const freshnessSeconds = freshnessMs / 1000
  return {
    why: 'the sender and the viewer are the SAME machine, so the difference carries NO clock-skew term at all',
    sender,
    sender_clock: senderClock,
    seq,
    text,
    send_acked_iso: new Date(send).toISOString(),
    send_acked_epoch_ms: send,
    dom_arrival_iso: new Date(arrival).toISOString(),
    dom_arrival_epoch_ms: arrival,
    freshness_ms: freshnessMs,
    freshness_seconds: freshnessSeconds,
    verdict: freshnessSeconds <= FRESHNESS_BOUND_SECONDS
      ? `pass — ${freshnessSeconds.toFixed(3)} s against the ${FRESHNESS_BOUND_SECONDS} s bound`
      : `fail — ${freshnessSeconds.toFixed(3)} s against the ${FRESHNESS_BOUND_SECONDS} s bound`,
  }
}

// The cross-machine measurement: the sender is the OTHER machine, so the
// two clocks differ — the offset is MEASURED against the server's HTTP Date
// header (the common reference; 1-second resolution, so each median carries
// ~±450 ms of quantization and their DIFFERENCE inherits up to ~±900 ms
// before any network asymmetry).
export function computeCrossMachine(input) {
  const sendAckedEpochMs = pick(input, 'sendAckedEpochMs', 'send_acked_epoch_ms')
  const domArrivalEpochMs = pick(input, 'domArrivalEpochMs', 'dom_arrival_epoch_ms')
  const { viewerClock, sender, senderClock, seq, text } = input ?? {}
  const offsets = input?.clock_offsets_vs_server_ms
  const macOffsetMs = pick(input, 'macOffsetMs', null) ?? offsets?.mac
  const stagingOffsetMs = pick(input, 'stagingOffsetMs', null) ?? offsets?.staging
  const offsetSamplesPerClient = input?.offsetSamplesPerClient ?? offsets?.samples_per_client
  const send = epochMs(sendAckedEpochMs, 'sendAckedEpochMs')
  const arrival = epochMs(domArrivalEpochMs, 'domArrivalEpochMs')
  const rawDifferenceMs = arrival - send
  const mac = epochMs(macOffsetMs, 'macOffsetMs')
  const staging = epochMs(stagingOffsetMs, 'stagingOffsetMs')
  const offsetStagingMinusMacMs = staging - mac
  const correctedFreshnessMs = rawDifferenceMs + offsetStagingMinusMacMs
  const freshnessSeconds = correctedFreshnessMs / 1000
  return {
    why: 'the sender is the OTHER physical machine, so the two clocks differ; the offset is measured, not assumed',
    sender,
    sender_clock: senderClock,
    viewer_clock: viewerClock,
    seq,
    text,
    send_acked_iso: new Date(send).toISOString(),
    send_acked_epoch_ms: send,
    dom_arrival_iso: new Date(arrival).toISOString(),
    dom_arrival_epoch_ms: arrival,
    raw_difference_ms: rawDifferenceMs,
    clock_offset_method: 'the server\'s HTTP Date header is the common reference: 9 samples per client, the median of (client midpoint - server epoch). The header has 1-second resolution, so each median carries about +/-450 ms of quantization uncertainty, and the DIFFERENCE of the two medians inherits up to about +/-900 ms from that term alone, before any network asymmetry.',
    clock_offsets_vs_server_ms: { mac, staging, samples_per_client: offsetSamplesPerClient },
    offset_staging_minus_mac_ms: offsetStagingMinusMacMs,
    arithmetic: 'elapsed = (viewer_clock - mac_offset) - (sender_clock - staging_offset) = raw_difference + (staging_offset - mac_offset)',
    corrected_freshness_ms: correctedFreshnessMs,
    corrected_freshness_seconds: freshnessSeconds,
    reported_as: `${freshnessSeconds.toFixed(3)} s (the corrected cross-machine freshness), with up to about +/-0.9 s of clock-offset uncertainty from the 1-second-resolution Date header.`,
    verdict: freshnessSeconds <= FRESHNESS_BOUND_SECONDS
      ? `pass — ${freshnessSeconds.toFixed(3)} s corrected (raw ${(rawDifferenceMs / 1000).toFixed(3)} s) against the ${FRESHNESS_BOUND_SECONDS} s bound`
      : `fail — ${freshnessSeconds.toFixed(3)} s corrected against the ${FRESHNESS_BOUND_SECONDS} s bound`,
  }
}

export const HONEST_LIMITS = [
  'The measured interval is sender-acknowledgement -> DOM card insertion, not send-start -> painted pixel. The acknowledgement is after the commit and the observer fires before the paint, so the interval is not the whole user-perceived latency.',
  'The cross-machine number carries the clock-offset uncertainty stated above (each offset median has about +/-450 ms of quantization; their difference up to about +/-900 ms). The same-clock number carries no clock term at all.',
  'Only the two canary sequences are the freshness measurements; conversation broadcasts are recorded with their live DOM arrival instants too, but no sender-acknowledgement instant was paired with them.',
]

// Assemble the full freshness.json document from a raw measurement input.
export function buildFreshnessDocument(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('the freshness measurement input must be an object')
  }
  return {
    story: input.story ?? '6.1',
    requirement: input.requirement ?? `REL-1 — the physical two-machine demonstration; the viewer's broadcast freshness within ${FRESHNESS_BOUND_SECONDS} seconds`,
    bound_seconds: FRESHNESS_BOUND_SECONDS,
    method: input.method ?? 'The browser\'s DOM carries a MutationObserver installed on the viewer\'s message list; it records the wall-clock instant each message card FIRST appears (a per-sequence set, so a catch-up page is recorded once and a live SSE frame is recorded at its arrival). The sender records the instant the server acknowledged its send (the api-client\'s own clock, immediately after the committed answer). The difference is the viewer\'s freshness.',
    same_clock_measurement: computeSameClock(input.same_clock_measurement),
    cross_machine_measurement: computeCrossMachine(input.cross_machine_measurement),
    honest_limits: [...HONEST_LIMITS],
  }
}

// Recompute-and-compare: given a parsed freshness.json, recompute both
// measurements from the recorded raw epoch fields and verify the recorded
// derived numbers match (arithmetic drift between the writer and this
// module is a failure, not a rounding note). Returns a list of mismatch
// strings — empty means the document's arithmetic holds.
export function recomputeFreshnessDocument(document) {
  const mismatches = []
  const same = document?.same_clock_measurement
  const cross = document?.cross_machine_measurement
  if (!same || !cross) {
    return ['the document is missing a measurement half']
  }
  try {
    const recomputed = computeSameClock(same)
    if (recomputed.freshness_ms !== same.freshness_ms) {
      mismatches.push(`same-clock freshness_ms: recorded ${same.freshness_ms}, recomputed ${recomputed.freshness_ms}`)
    }
    if (recomputed.freshness_seconds !== same.freshness_seconds) {
      mismatches.push(`same-clock freshness_seconds: recorded ${same.freshness_seconds}, recomputed ${recomputed.freshness_seconds}`)
    }
  } catch (error) {
    mismatches.push(`same-clock recompute failed: ${error.message}`)
  }
  try {
    const recomputed = computeCrossMachine(cross)
    if (recomputed.raw_difference_ms !== cross.raw_difference_ms) {
      mismatches.push(`cross raw_difference_ms: recorded ${cross.raw_difference_ms}, recomputed ${recomputed.raw_difference_ms}`)
    }
    if (recomputed.offset_staging_minus_mac_ms !== cross.offset_staging_minus_mac_ms) {
      mismatches.push(`cross offset term: recorded ${cross.offset_staging_minus_mac_ms}, recomputed ${recomputed.offset_staging_minus_mac_ms}`)
    }
    if (recomputed.corrected_freshness_ms !== cross.corrected_freshness_ms) {
      mismatches.push(`cross corrected_freshness_ms: recorded ${cross.corrected_freshness_ms}, recomputed ${recomputed.corrected_freshness_ms}`)
    }
    if (recomputed.corrected_freshness_seconds !== cross.corrected_freshness_seconds) {
      mismatches.push(`cross corrected_freshness_seconds: recorded ${cross.corrected_freshness_seconds}, recomputed ${recomputed.corrected_freshness_seconds}`)
    }
  } catch (error) {
    mismatches.push(`cross recompute failed: ${error.message}`)
  }
  if (!(same.freshness_seconds <= FRESHNESS_BOUND_SECONDS)) {
    mismatches.push(`same-clock freshness ${same.freshness_seconds} s exceeds the ${FRESHNESS_BOUND_SECONDS} s bound`)
  }
  if (!(cross.corrected_freshness_seconds <= FRESHNESS_BOUND_SECONDS)) {
    mismatches.push(`cross-machine freshness ${cross.corrected_freshness_seconds} s exceeds the ${FRESHNESS_BOUND_SECONDS} s bound`)
  }
  if (!Array.isArray(document.honest_limits) || document.honest_limits.length < 3) {
    mismatches.push('the honest limits are missing')
  }
  return mismatches
}
