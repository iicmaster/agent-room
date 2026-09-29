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
- The per-realm Allowlist and the client-side trust matrix: own-Actor and Local Mode
  senders deliver, allowlisted remote Actors deliver, and every other remote sender is
  held (metadata only, body withheld, reason recorded). State lives at
  `PLUGIN_DATA/realms/<realm_id>/allowlist.json` (0600, atomic) and binds key
  fingerprints, never Chat IDs. Two additive MCP tools — `room_trust_list` and
  `room_trust_set` — inspect and add/remove fingerprint entries; accept-all is a
  per-realm human CLI opt-in (default false) that no agent tool can set.
- The held pipeline (metadata-only and recoverable): every held message registers into
  `PLUGIN_DATA/realms/<realm_id>/held.json` (0600, atomic) keyed (realm, room, seq) with
  realm, sender Chat ID, fingerprint, room, sequence, time, byte size, and the trust
  reason, plus a body cache bounded at 100 copies (drop-oldest) — eviction drops only
  the cached body copy and never deletes, approves, or skips a record, and an evicted
  body recovers by a point read (`after_seq = seq − 1`, `limit = 1`) through the
  api-client. Two additive MCP tools — `room_held_list` (metadata only, never a body)
  and `room_held_count` — surface the held state to the agent; the body-recovery and
  release functions are reachable only from the human CLI, so no tool result can ever
  carry a held body. Held registration happens after the read cursor persists: a held
  message never stalls the cursor and a cursor advance never loses held state.
- The human CLI surface over the held pipeline and the per-realm allowlist (the
  `agent-room` bin's command family): `held list` (metadata only — id, chat id,
  fingerprint, room, sequence, time, size, reason, with an optional `--room`
  filter), `held show <room_id>:<seq>` (the full preview of the exact artifact
  the pipeline withheld, by cached copy or point-read recovery — the only
  surface where held body text appears; every body line carries a `| ` prefix
  so a hostile body can never forge the delimiters or fake CLI output),
  `allow <chat-id>` (resolves the name
  to its key fingerprint from this realm's held records and presence,
  case-insensitively and merged by fingerprint — never a silent guess;
  `--fingerprint` disambiguates a reused name; reports realm + fingerprint;
  saves the allowlist entry — recording the chat id it was granted under —
  and releases that key's held records; `--remove` resolves from the
  allowlist itself and affects future ingestion only), and `allow-all` (the per-realm accept-all
  flip behind an explicit interactive y/N confirmation; `--remove` switches it
  off without one, and a non-TTY stdin is refused before anything is booted). The commands' session is unbound — the local token and the
  installation key are exchanged for a session token and no Chat ID is ever
  claimed — so they run collision-free while the live MCP session holds the
  configured name and leave no presence or claim footprint. Approval is a
  human convention (Instructed): same-user processes are not cryptographically
  distinguishable, and the help text says so plainly.
- `outcome_unknown` send resolution: one automatic retry with the identical
  `client_message_id` resolves to the original message or a coded conflict, never a duplicate.
- The end-to-end trust-chain drill (`tests/integration/trust-chain.test.mjs`): one
  zero-mock integration test over the real MCP response path — two real `mcp-stdio`
  children on distinct installations (distinct keypairs, `client_type: 'mcp'` binds) —
  chaining stranger hold (zero body bytes in every agent-visible result), cursor
  persistence past the held seq, evicted-body recovery via `agent-room held show`
  byte-matching the durable log, `allow` release of held and future messages,
  `--remove` re-holding the future without touching the past, and per-room cursor
  monotonicity at every step.
- The connection-mode declaration seam: an installation whose host knows its session
  crosses the OS-user boundary declares `AGENT_ROOM_CONNECTION_MODE=remote` (exact
  match; any other value keeps the earned behavior, and `'local'` is only ever earned
  by the local token exchange). The declared mode is strictly fail-closed — the trust
  matrix's remote lane can only withhold deliveries, never grant them — and is the
  transport input Epic 4's challenge-authenticated clients will carry naturally.
- Remote challenge authentication (the remote half of the one-session-mechanism
  split): `POST /api/auth/challenge` issues a single-use 32-byte nonce (60 s expiry,
  bounded pending set, in-memory — a restart invalidates outstanding challenges)
  bound to the presented raw public key, open to any well-formed key so invite
  enrollment can prove possession; `POST /api/auth/answer` consumes the nonce
  before verifying the Ed25519 signature against the challenge-recorded key
  (identity binds at challenge time, a failed answer burns the nonce, replays find
  an empty slot) and — gated on the new durable `enrolled_actors` registry seeded by
  the local exchange's success path — issues a session token from the same registry
  the local path uses (12 h sliding; DR-2 ratified as declared). A declared-remote
  installation (`AGENT_ROOM_CONNECTION_MODE=remote` or the `connectionMode` option)
  now authenticates through this challenge lane and never presents the local token
  file; its `transport: 'remote'` is earned by the exchange, and coded failures
  (`not_enrolled`, `challenge_invalid`) surface as coded errors with no fallback.
  The private key never leaves `server/keys.mjs`: signing reads the PEM and returns
  only the signature.

### Removed

- The v0.1 MCP tool surface (`room_create`/`room_join`) that spoke the unix-socket daemon.
  The retired daemon modules remain in the repository untouched pending Epic 2/5 decisions;
  nothing in production spawns them anymore.

## 0.1.0 - 2026-08-31

- Add the Agent Plugins 1.0.0 package and generated Claude Code compatibility package.
- Add the MCP chat-room service and read-only live web viewer.
