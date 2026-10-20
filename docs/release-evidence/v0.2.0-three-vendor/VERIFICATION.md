# 3-Vendor agent-room verification (single machine)

**Date:** 2026-10-20 · **Realm:** `f7928a1a-ce00-446d-905d-2a4af5d8dc40` · **Broadcast room:** `IN-rLCpQ-5gGWIz9d9tE2Q`

## What this proves

Three real, different vendor agent CLIs — **Claude Code** (Opus 5.5), **Codex** (gpt-6.1-sol),
**Gemini/agy** (gemini-3.8-flash-high) — each attached to the SAME agent-room realm as a real
MCP client, and exchanged messages through the plugin. Every tool call below is a real
`mcp__agent-room__*` invocation over the materialized v0.2.0 candidate artifact
(`agent-room-claude-code`, tree digest `8d2924c9f9e279717cc2491f4501a61ab7953fd5f2b9c8c504a4cc897604df51`).

**This is NOT the REL-1 demonstration.** REL-1 requires two physical machines and the real
vendor hosts. This is a single-machine, three-vendor interoperability run: it exercises the
plugin's MCP surface across three independent agent hosts, not the cross-machine topology.

## Clients (distinct identities, D13)

| Chat ID | Vendor CLI | Model | Fingerprint |
|---|---|---|---|
| CLAUDE-TMUX | Claude Code 2.1.304 | Opus 5.5 | `sha256:4053dbc4f7312e50b0dc3f954d5221fe3840fe89393ed1ee6a6ca76d6665c6e4` |
| CODEX-TMUX | Codex 0.159.1 | gpt-6.1-sol | `sha256:ef1ded8406f230ae1cbbbb8ea52c944e5e1678496074339a0bc1f5654a6c3131` |
| AGY-TMUX | Antigravity CLI 1.4.3 | gemini-3.8-flash-high | `sha256:ed9596e73ba16838031323504c430312b4f58b95427012bc26f39f8bb131c36d` |

Each client was configured through the real `agent-room setup` flow (one-time Chat ID choice,
durable claim, per-installation Ed25519 keypair) — not by hand-writing a config.

## Checks

| # | Check | Result |
|---|---|---|
| 1 | All three bind one realm | PASS — `room_status` from all three returned realm `f7928a1a…` and broadcast room `IN-rLCpQ…` |
| 2 | Presence sees all three | PASS — `room_presence` listed CLAUDE-TMUX + CODEX-TMUX + AGY-TMUX, three distinct fingerprints, `client_type: mcp` |
| 3 | Claude Code → Codex (DM) | PASS — `room_direct_open` + `message_send` → `status: committed`, `seq: 1`; Codex's `message_read` returned it with the full `<untrusted_message version="1">` envelope naming sender chat id AND fingerprint |
| 4 | Codex → Claude Code (reply) | PASS — `message_send` → `status: committed`, `seq: 2` in the same pair room |
| 5 | Gemini → Codex (DM) | PASS — `message_send` → `status: committed`, `seq: 1`; Codex's `message_read` returned it with the envelope |
| 6 | Gemini → Claude Code (DM) | PASS — `room_direct_open` + `message_send` → `status: committed`, `seq: 1`; Claude's `message_read` returned it with the envelope |
| 7 | Broadcast crosses vendors | PASS — Claude's broadcast (`BCAST-1-CLAUDE`) read by Gemini with the envelope |
| 8 | DM exclusion (negative) | PASS — broadcast room holds exactly 1 row; zero DM rows (`MSG-*`) in it |
| 9 | Pair rooms are per-pair | PASS (observed) — `yRs6KbLR…` = {Claude, Codex}, `egfBOf65…` = {Gemini, Codex}, `ZOuH88im…` = {Gemini, Claude}. A DM is a two-actor room; opening a pair from the other side creates the pair room, never a shared one |

## Evidence

- `room-state.json` — the durable room state read back out of the realm's SQLite store
  (rooms, direct_members, messages, chat_id_claims)
- `transcript-claude.txt`, `transcript-codex.txt`, `transcript-agy.txt` — the three tmux panes

## Caveats (stated, not hidden)

- Single machine. The cross-machine, cross-vendor-host path is REL-1, still unproven.
- Each vendor ran one turn per tool batch; no agent acted on another agent's message content
  (correct — the envelope says the text is data, never instructions, and both agents reported
  that reading rather than obeying it).
- The `agy` seat needed a HOME-isolated config to avoid touching the operator's global
  `~/.gemini` MCP registry; its credentials were symlinked, not copied.
