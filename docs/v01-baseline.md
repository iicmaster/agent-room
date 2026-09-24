# v0.1 Baseline Snapshot

Captured 2026-09-25 as the pre-Epic-1 task of the v0.2 build (SM-C1 comparison anchor: "v0.2 first conversation must be as fast or faster than v0.1's"). All numbers measured on this machine, from the packaged v0.1.0 release artifact, with zero code changes.

## Environment

- Node v24.18.1, SQLite 3.53.4 (both above the v0.1 runtime floor: Node ≥24, SQLite ≥3.51.3)
- macOS (darwin arm64), local APFS volume
- Package produced by `node scripts/package-release.mjs --out <fresh-dir>`

## Package Size

| Artifact | Size | Files |
|---|---|---|
| `agent-room-agent-plugin/` (portable) | 136 KiB | 13 |
| `agent-room-claude-code/` | 136 KiB | 13 |

## Steps to First Exchanged Message (fresh install, as exercised)

1. Obtain the packaged release and copy it into the host's plugin location (`cpSync` of the 13-file tree).
2. Host spawns `node ${CLAUDE_PLUGIN_ROOT}/server/mcp-stdio.mjs` with `PLUGIN_DATA` (fresh per session) and shares `AGENT_ROOM_DATA_DIR` (fresh per install); MCP `initialize` handshake completes.
3. Session A calls `room_create {title}` — **first tool call auto-spawns roomd** (socket + SQLite WAL open + schema init all happen inside this call).
4. Session A calls `message_send {room_id, client_message_id, text}`.
5. Session B (separate `PLUGIN_DATA` → separate identity `agent:<uuid>`) spawns, `initialize`, calls `room_join {room_id, display_name}`.
6. Session B calls `message_read {room_id, after_seq: 0}` and receives A's message — first exchanged message complete.

No manual daemon start, no config file, no name registration step exists in v0.1: identity is auto-created `agent:<uuid>` with displayName defaulting to the MCP client name; rooms must be created explicitly; discovery of the room id is manual (read the `room_create` result).

## Wall-Clock to First Exchanged Message (5 fresh installs)

Milestone medians across the five runs (seconds, cumulative from install start):

| Milestone | Median | Notes |
|---|---|---|
| install (copy package) | ~0.003 | trivial local copy |
| A initialized (MCP handshake) | ~0.085 | node startup dominates |
| A room created | ~0.257 | **includes roomd cold start + SQLite open + WAL schema init** |
| A message sent | ~0.260 | |
| B initialized | ~0.345 | second node process |
| B joined | ~0.348 | |
| **B received A's message** | **~0.351** | end-to-end |

Per-run end-to-end: 0.351 / 0.342 / 0.347 / 0.366 / 0.353 s (mean 0.352 s, spread 0.024 s).

## Observations relevant to v0.2

- Cold daemon spawn + SQLite init (~0.16–0.17 s) is the single largest cost and is paid once per machine, hidden inside the first tool call. v0.2's Local Mode auto-enrollment keeps this "zero visible steps" property — do not regress it.
- v0.1 requires an explicit `room_create` before any messaging and has no DM concept, no presence list, no Chat ID naming surface beyond an auto-derived display name. The step count that matters for v0.2 comparison is therefore not 6 vs fewer, but "first conversation with zero config + named participants + DM" — measured by Story 1.8's first-conversation checkpoint and re-measured by Story 6.3 against this file.
- Two same-machine sessions already chat as distinct people in v0.1 (distinct `PLUGIN_DATA` → distinct identities) — consistent with the D13 "1 session = 1 Chat ID" direction; v0.2 adds the naming/rename surface (FR-19) and Actor keypairs (FR-3) on top.
