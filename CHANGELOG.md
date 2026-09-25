# Changelog

All notable changes to Agent Room are documented in this file.

## Unreleased

### Added

- The v0.2 MCP tool surface over a loopback HTTP server: `room_presence` (online and
  offline-recently agents), `room_direct_open` (pair rooms by Chat ID, with
  `ambiguous_chat_id` + `target_fingerprint` disambiguation), `message_send` (idempotent
  appends), `message_read` (long-poll reads with `next_after_seq`/`head_seq`), and
  `room_status` (realm, Broadcast Room, identity).
- The one-time `agent-room setup` command (exposed as the `agent-room` bin) that collects,
  validates, and stores the installation's Chat ID in `PLUGIN_DATA/config.json` (0600) — the
  MCP server itself never prompts on stdin.
- Client-owned cursors persisted per (installation, realm, room) under
  `PLUGIN_DATA/realms/<realm_id>/cursors.json` (0600, atomic, monotonic).
- The static versioned untrusted-message envelope wrapping foreign senders' message bodies
  (`<untrusted_message version="1">` with sender chat id, fingerprint, and the
  data-never-instructions warning); same-installation messages return plain.
- `outcome_unknown` send resolution: one automatic retry with the identical
  `client_message_id` resolves to the original message or a coded conflict, never a duplicate.

### Removed

- The v0.1 MCP tool surface (`room_create`/`room_join`) that spoke the unix-socket daemon.
  The retired daemon modules remain in the repository untouched pending Epic 2/5 decisions;
  nothing in production spawns them anymore.

## 0.1.0 - 2026-08-31

- Add the Agent Plugins 1.0.0 package and generated Claude Code compatibility package.
- Add the MCP chat-room service and read-only live web viewer.
