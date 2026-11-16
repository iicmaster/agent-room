// Story 4.1 — AQ-2, the PURE Claude-channel capability probe.
//
// This module is the ONLY authority on whether this host may receive Tier 1A
// active channel pushes. It is deliberately separate from every adapter so it
// can be tested in isolation: it does no I/O, reads no config, and NEVER infers
// the tier from plugin presence, environment variables, or a `wait.lock`.
//
// The one truth source is the `initialize` handshake's `params.capabilities`.
// Tier 1A Active requires BOTH:
//   - `capabilities.experimental['claude/channel']` is present and not false/null
//   - it does not assert `channelsEnabled: false` (nor does the capabilities
//     envelope itself)
// Every other shape — experimental missing, the channel key missing, the key
// explicitly disabled, or a non-object params — reports the honest unverified
// tier. An unverified host NEVER gets an active push.

export const CHANNEL_TIER = Object.freeze({
  ACTIVE: '1A-active',
  UNVERIFIED: 'channel-ready-unverified',
})

export const CHANNEL_TIER_LABEL = Object.freeze({
  [CHANNEL_TIER.ACTIVE]: 'Tier 1A Active',
  [CHANNEL_TIER.UNVERIFIED]: 'Channel-Ready, Host --channels Unverified',
})

// Probe the initialize params. `params` is the JSON-RPC `initialize` params
// object ({ protocolVersion, capabilities, clientInfo }); only `capabilities`
// is consulted. Returns { tier, label, source, freshness }.
export function verifyClaudeChannel(params) {
  const capabilities = params && typeof params === 'object' && !Array.isArray(params)
    ? params.capabilities
    : null
  const unverified = source => ({
    tier: CHANNEL_TIER.UNVERIFIED,
    label: CHANNEL_TIER_LABEL[CHANNEL_TIER.UNVERIFIED],
    source,
    freshness: 'initialize-handshake',
  })

  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return unverified('initialize.capabilities: missing')
  }
  if (capabilities.channelsEnabled === false) {
    return unverified('initialize.capabilities.channelsEnabled: false')
  }
  const experimental = capabilities.experimental
  if (experimental === null || typeof experimental !== 'object' || Array.isArray(experimental)) {
    return unverified('initialize.capabilities.experimental: missing')
  }
  const channel = experimental['claude/channel']
  if (channel === undefined || channel === null || channel === false) {
    return unverified("initialize.capabilities.experimental['claude/channel']: missing")
  }
  if (channel !== true && typeof channel === 'object' && channel.channelsEnabled === false) {
    return unverified("initialize.capabilities.experimental['claude/channel'].channelsEnabled: false")
  }
  return {
    tier: CHANNEL_TIER.ACTIVE,
    label: CHANNEL_TIER_LABEL[CHANNEL_TIER.ACTIVE],
    source: "initialize.capabilities.experimental['claude/channel']",
    freshness: 'initialize-handshake',
  }
}

// True only for the verified-active tier. The single predicate the push path
// uses so no caller re-implements the AQ-2 decision.
export function isChannelActive(verification) {
  return verification?.tier === CHANNEL_TIER.ACTIVE
}
