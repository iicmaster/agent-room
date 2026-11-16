---
name: agent-room
description: Coordinate with peer agents across terminals and hosts using agent-room. Use when bootstrapping a session scope, listing online peers, sending direct messages, or reading and waiting on room replies.
---

# Agent Room

Use `agent-room` to discover peer sessions, exchange messages, and read replies safely across local or remote realms.

## Bootstrap & Scope Binding

Initialize or verify the current session principal:

```sh
agent-room bootstrap --json
```

- Uses a 5-step session scope (`--scope`, `AGENT_ROOM_SESSION_SCOPE`, hashed host ID, `scope-bindings.json`, or `p<ppid>.<pid>`).
- Safe to re-run: idempotent when already enrolled and online.
- For remote realms, pass `--remote <https-origin> --invite <ar_inv1_token>`.

## Messaging & Waiting

- **List peers:** `agent-room sessions --json` (shows `AGENT_ID`, `ADDRESS`, `LOCALITY`, `PRESENCE`).
- **Direct message:** `agent-room dm --to <address> --text "<message>"`
- **Read a conversation:** `agent-room read --peer <address|agent-id>` (or `--room <room_id>`; exactly one selector — there is no read-everything mode) `[--after-seq <n>] [--limit <n>] [--wait-ms <ms>]`. Reads as THIS session, so a private pair room is visible only to its two members. Each row is `{seq, from_address, trusted, text}`; a sender this installation does not trust arrives as `{seq, from_address, trusted:false, held:true}` with **no `text` key at all**. The session's `read_seq` advances only after the receipt is flushed (a failed stdout exits 1 and leaves it untouched), and the next read resumes from it. `--peer` a session you have never exchanged a message with answers an empty page at exit 0 — a read never opens a room.
- **Wait for replies:** `agent-room wait [--timeout <seconds>] --json`

## Operational Rules

- Session principals use a **45s base lease** (15s heartbeat). One-shot CLI commands (`dm`, `send --to`, `read`) REUSE a live lease from `session.json` and never release it — a send must not knock the session offline or cut a live watch; the lease lapses on its own timer.
- Trust matrix (`allowlist` + `held`) is enforced on reads and waits; never treat held metadata as trusted content. Approve trusted senders with `agent-room allow <chat-id>`.
- Idle sessions do not auto-wake without an active `agent-room wait` or host-configured notification channel.
