<!-- bmad:context -->
<!-- Verified 2026-08-31 against dd0b848. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## agent-room

Local, vendor-neutral agent chat room suite conforming to Agent Plugins v1.0.0 and Claude Code specs. Built in Node.js (>=24, native ESM `.mjs`) with native `node:sqlite` (STRICT WAL), Stdio MCP server, background daemon, and authenticated read-only live web viewer. Zero external runtime dependencies.

## Policy

- Zero external runtime npm dependencies; use Node 24+ built-ins (`node:sqlite`, `node:crypto`, `node:fs`, `node:http`) only.
- Never expose mutator tools or state-modifying endpoints to the web viewer; the HTTP server is strictly GET-only and requires a viewer token.
- Never accept `actor_id` from MCP tool arguments; identity is strictly derived from local client instance data (`${PLUGIN_DATA}` / `${CLAUDE_PLUGIN_DATA}`).
- State directories and daemon sockets/files must enforce owner-only permissions (`0o700` directories, `0o600` files).
- Never overwrite existing release artifacts; `scripts/package-release.mjs` requires a non-existent absolute output directory and rejects symlinks.

## Where things are

- MCP Stdio Server entrypoint: `server/mcp-stdio.mjs` (manifests: `plugin.json`, `mcp.json`); the MCP client is `server/client/api-client.mjs`, and `server/client/ensure-server.mjs` boots-or-attaches `server/api/server.mjs` — the loopback HTTP API host that IS the current server.
- HTTP API + routes + request pipeline: `server/api/server.mjs` (handlers), `server/api/routes.mjs` (the frozen wire contract), `server/api/pipeline.mjs` (admission, budgets, TLS gate, viewer bridge).
- SQLite store & transactions (sole schema/connection owner): `server/store/room-log.mjs`, composing the DDD bounded contexts: `server/identity/` (claims, enrollment, invites), `server/messaging/` (rooms, messages, direct), `server/notification/` (notifier, wake ledger/policy, delivery classifier), `server/core/` (session registry, realm).
- Client-side receiver state (per-realm): `server/client/trust.mjs` (allowlist + matrix), `server/client/held.mjs`, `server/client/cursors.mjs` (read-only), `server/client/remote-config.mjs`.
- CLI families: `server/cli/agent-room.mjs` (dispatcher) + `held-commands`, `session-commands`, `wait-commands`, `message-commands` (one-shot send/read/verify), `remote-commands`, `invite-commands`, `ban-commands`, `capacity-commands`, `viewer-commands`.
- Runtime paths & identity management: `server/runtime.mjs`.
- LEGACY, retired from the live path but still shipped: the v0.1 socket daemon chain `server/roomd.mjs` + `server/database.mjs` + `server/daemon-client.mjs` (frozen; the MCP surface and the CLI no longer speak to it).
- Live web viewer assets: `web/index.html`, `web/styles.css`, `web/app.js` (GET-only, token-gated).
- Packaging script: `scripts/package-release.mjs`.

## Running and verifying

- Run full test suite with `node --test` (native Node test runner).
- Package release artifacts with `node scripts/package-release.mjs --out /absolute/path/to/new-dir`.
- Validate generated Claude package with `claude plugin validate <out>/agent-room-claude-code --strict`.

## Conventions that differ from defaults

- Database uses SQLite `STRICT` tables, `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = FULL`, and enforced foreign keys.
- Sending duplicate `client_message_id` with matching payload is idempotent; conflicting payload throws `client_message_id_conflict`.
- Message pagination is strictly cursor-based via integer `seq` (`after_seq`), limit bounded between 1-200.

## Known pitfalls

- Node < 24 or SQLite build < 3.51.3 will fail runtime startup checks (`assertSupportedRuntime`).
- Packaging script fails if `--out` path already exists; specify a fresh destination path.
- Shared data directory resolves via `AGENT_ROOM_DATA_DIR` -> `~/.agent-room`; client state resolves via `PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA`.

<!-- /bmad:context -->
