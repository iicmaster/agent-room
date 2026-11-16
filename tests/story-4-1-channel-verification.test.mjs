// Story 4.1 AQ-2: the pure capability probe, tested in isolation. No I/O, no
// guessing from config/plugin/wait.lock. Three real host shapes → 1/0/0 active.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHANNEL_TIER,
  isChannelActive,
  verifyClaudeChannel,
} from '../server/client/channel-verification.mjs'
import {
  MCP_CHANNEL_OUTBOUND_MAX_BYTES,
  MCP_PROTOCOL_DOWNGRADE_FROM,
  MCP_PROTOCOL_VERSION,
  MCP_RESOURCE_SUBSCRIPTIONS_MAX,
  MCP_WAKE_P95_MS,
  MCP_WAIT_YIELD_MS,
} from '../server/constants.mjs'

const caps = capabilities => ({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities })

test('the three host fixtures yield exactly 1 / 0 / 0 active tiers', () => {
  const hosts = [
    caps({ experimental: { 'claude/channel': {} } }),          // --channels host
    caps({}),                                                   // generic, no experimental
    caps({ experimental: { 'claude/channel': { channelsEnabled: false } } }), // disabled
  ]
  const verdicts = hosts.map(verifyClaudeChannel)
  const active = verdicts.map(v => v.tier === CHANNEL_TIER.ACTIVE ? 1 : 0)
  assert.deepEqual(active, [1, 0, 0])
  assert.equal(verdicts[0].label, 'Tier 1A Active')
  for (const index of [1, 2]) {
    assert.equal(verdicts[index].label, 'Channel-Ready, Host --channels Unverified')
  }
})

test('the probe reports its truth source and freshness', () => {
  const result = verifyClaudeChannel(caps({ experimental: { 'claude/channel': true } }))
  assert.equal(result.freshness, 'initialize-handshake')
  assert.match(result.source, /experimental/)
  assert.equal(isChannelActive(result), true)
  assert.equal(isChannelActive(verifyClaudeChannel(caps({}))), false)
})

test('a channel key set false, null, or a disabled envelope is never active', () => {
  const shapes = [
    caps({ experimental: { 'claude/channel': false } }),
    caps({ experimental: { 'claude/channel': null } }),
    caps({ channelsEnabled: false, experimental: { 'claude/channel': {} } }),
  ]
  for (const shape of shapes) assert.equal(isChannelActive(verifyClaudeChannel(shape)), false)
})

test('non-object initialize params fail closed to unverified', () => {
  for (const bad of [undefined, null, 'x', 42, [], {}]) {
    assert.equal(isChannelActive(verifyClaudeChannel(bad)), false)
  }
})

test('Story 4.1 AD-9 constants are owned once with their ratified values', () => {
  assert.equal(MCP_PROTOCOL_VERSION, '2025-06-18')
  assert.deepEqual([...MCP_PROTOCOL_DOWNGRADE_FROM], ['2025-11-25', '2026-07-28'])
  assert.equal(MCP_RESOURCE_SUBSCRIPTIONS_MAX, 20)
  assert.equal(MCP_CHANNEL_OUTBOUND_MAX_BYTES, 64 * 1024)
  assert.equal(MCP_WAKE_P95_MS, 250)
  assert.equal(MCP_WAIT_YIELD_MS, 1000)
})
