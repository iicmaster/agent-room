# HANDOFF — agent-room v0.9.0

## 1. READ THIS FIRST

- Branch `main`, pushed to `origin/main`; HEAD `973e4f2`.
- Child repository was clean before this handoff; this file is tracked.
- Product goal: vendor-neutral SendMessage across sessions and machines.
- v0.9.0 is released and deployed to ngs-2; do not confuse deployment with ZCode acceptance.
- **Danger:** 22 active MCP adapter processes were measured sharing `.vendor-lab/zcode-client-1`; 12 ran 0.8.0, 10 ran 0.9.0. Do not `session replace` while a holder may be alive.
- ZCode cross-session chat remains **unproven**: remote listing showed its retained principal offline; no two-ZCode nonce round trip has been recorded.
- The correct ZCode acceptance is two distinct live principals, send a unique nonce, read it at the other session, reply with that nonce.

## 2. HOW TO VERIFY

```sh
cd /Users/ngs/agent-skills/plugins/agent-room
npm test
```

Measured on 2026-11-14 after commit `973e4f2`: `tests 768`, `pass 768`, `fail 0`, exit 0 (~430 s). `npm test` is `node --test`; it does not exercise the live ZCode host.

Read-only remote listing with the ZCode installation identity:

```sh
PLUGIN_DATA="$PWD/.vendor-lab/zcode-client-1" \
NODE_EXTRA_CA_CERTS="$PWD/.vendor-lab/tls/ca.pem" \
node server/cli/agent-room.mjs sessions
```

Measured 2026-11-15: realm `308fb41d-f0f8-4b22-b9b6-78bc0f3723ed`; `agent-room-zcode-1` appeared `offline` (retained principal). This listing is not a proof of two live ZCode sessions or successful chat.

Inspect which adapter builds remain alive:

```sh
ps -Ao pid=,command= | grep '[m]cp-stdio.mjs' | \
  sed -E 's#.*releases/([^/]+)/server/mcp-stdio\.mjs.*#\1#' | sort | uniq -c
```

Measured 2026-11-15: 12 processes on `0.8.0`, 10 on `0.9.0`; all 22 used `.vendor-lab/zcode-client-1`. After the user restarts ZCode, expect only the configured `0.9.0` adapter for newly launched processes. Existing host processes may outlive a config change.

## 3. STATE

- **Released/deployed:** v0.9.0 session addressing is on `main`; implementation commit `f6ac51b`, release commit `335d72e`, current `main` includes README fix `973e4f2`. Read `server/identity/session-principals.mjs:187-245`, `server/api/server.mjs:1111-1258`, `server/api/server.mjs:1288-1312`. The normative spec resides in the parent workspace at `../../_bmad-output/specs/spec-agent-room-v090/` (not in this child repo).
- **Addressed send:** `POST /api/messages {to,text,client_message_id}` resolves the full session address, quietly refuses an unknown peer, opens/reuses the session-pair room, appends and returns committed sequence/presence. Read `server/api/server.mjs:1288-1312`; E2E: `tests/addressed-send.test.mjs:203-270`.
- **Session-pair DM:** canonical pair key uses both session IDs under `ssession:`; each pair has membership/ACL. Read `server/messaging/session-pairs.mjs:22-52`, `server/messaging/session-pairs.mjs:84-175`.
- **Implementation record/review:** lives in the parent workspace at `../../_bmad-output/implementation-artifacts/spec-agent-room-v090-session-addressing.md`; not tracked in this child repo.
- **ZCode configuration:** `~/.zcode/cli/config.json` points to `~/.local/share/agent-room/releases/0.9.0/server/mcp-stdio.mjs`, with `PLUGIN_DATA=.vendor-lab/zcode-client-1` and the lab CA. Measured 2026-11-15. The config is correct; runtime processes are mixed versions.
- **Remote ZCode identity:** `.vendor-lab/zcode-client-1/remote-config.json` points to `https://43.229.78.103:18444`; its `config.json` Chat ID is `agent-room-zcode-1`. Read 2026-11-15; do not print `identity.key` or any capability.
- **Remote listing:** using that identity, `agent-room sessions` returned `agent-room-zcode-1` and `fresh-link-agent`, both retained/offline. Measured 2026-11-15; this does not identify which live process caused the earlier `chat_id_taken`.
- **README funnel:** fixed and pushed in `973e4f2`: remote join/enroll syntax, private-CA instructions, v0.9 tools and addressed DM. Read `README.md:49-75`, `README.md:250-269`, `README.md:338-355`.
- **External teaching artifact:** privately published at https://artifacts.ngs.bz/openclaw/private/agent-room-rooms-dm-explained/; SHA-256 `4211e0e0850e426f461dfcc4d835a9e5d3996db590a54e1ee2dc41f208e00a8f`, local archive `../../docs/artifacts/openclaw/private/agent-room-rooms-dm-explained/index.html`. Published and read back 2026-11-14; not part of the ZCode acceptance proof.

## 4. DO NOT

- **Do not `agent-room session replace` merely because `room_status` returned `chat_id_taken`.** The error does not reveal the holder; 22 live processes shared the same `PLUGIN_DATA`. A takeover is an explicit displacement, not cleanup. First let the owner stop/restart the relevant ZCode host; only recover after the incumbent is known dead and the operator authorizes it. Recovery mechanics and EOF/TTY trap: `docs/rel1-runbook.md:174-205`, `server/cli/session-commands.mjs:289-348`.
- **Do not use `.vendor-lab/rel1-zcode` to diagnose the current ZCode session.** It is a different installation/Chat ID (`ZCODE-MAC-2`); its successful `sessions` call proves only that separate identity can reach the realm. Current ZCode config uses `.vendor-lab/zcode-client-1`.
- **Do not infer delivery, reading, or model wake from `online`, `committed`, or a session listing.** The receipt proves a durable append; presence is transport liveness only. Read `README.md:374-386` and `server/api/server.mjs:1308-1330`.
- **Do not change server, addressability, or trust semantics to make this ZCode runtime test pass.** First make the host load the configured 0.9.0 adapter, then run the real acceptance round trip.
- **Do not stage or commit the parent `/Users/ngs/agent-skills` repository as part of this handoff.** Its index/worktree contains unrelated staged and modified work. Commit only the named path in this child repository.

## 5. DECIDED — DO NOT RELITIGATE

- **User decision:** product target is vendor-neutral SendMessage across sessions and machines, usable by every tool; per-session addressability is required. Source: `_bmad-output/specs/spec-agent-room-v090/SPEC.md` (CAP-1..8) and `session-principals.md`.
- **User decision:** unknown destinations are refused quietly; roster discovery is a separate explicit command. Implemented by `peer_not_found` in `server/api/server.mjs:1285-1305` and listing route `server/api/server.mjs:1246-1258`.
- **User decision:** Local Mode remains the default; Remote Mode is opt-in and HTTPS-only. `server/client/api-client.mjs:23-35`; TLS gate `server/api/pipeline.mjs:211-226`.
- **Security invariant:** installation key is the enrollment/trust identity; session principal is the routing/ACL/cursor identity. Session capability is a secret; the public session address is not. `server/identity/session-principals.mjs:10-18`, `_bmad-output/specs/spec-agent-room-v090/session-principals.md`.
- **Operator rule:** never displace a live name-holder automatically. `server/client/api-client.mjs:464-476`, `server/cli/session-commands.mjs:326-348`.

## 6. UNPROVEN

- **ZCode ↔ ZCode cross-session messaging:** no evidence yet of two distinct current ZCode principals online and completing a unique-nonce send/read/reply. Required before answering “yes.”
- **Which process held `agent-room-zcode-1` during the `chat_id_taken` response:** 22 adapters shared the same state directory, but the refusal intentionally does not disclose the holder. Do not assert a specific PID without a new measurement.
- **Whether restarting ZCode alone clears the collision:** not tested. After restart, inspect active versions and call `room_status`; if still refused, stop and diagnose before takeover.
- **The live remote acceptance path after a ZCode restart:** unit/E2E suite passes, and the CLI identity can list sessions, but the actual ZCode MCP tools have not completed the nonce round trip.

## 7. WHERE THINGS LIVE

- Contract/spec: `_bmad-output/specs/spec-agent-room-v090/SPEC.md`
- Identity model/protocol: `_bmad-output/specs/spec-agent-room-v090/session-principals.md`; `_bmad-output/specs/spec-agent-room-v090/session-protocol.md`
- Implementation record/review: `_bmad-output/implementation-artifacts/spec-agent-room-v090-session-addressing.md`
- Session principal store: `server/identity/session-principals.mjs`
- API + addressed send + principal listing: `server/api/server.mjs`
- Client auth/session lifecycle: `server/client/api-client.mjs`; `server/client/session-state.mjs`
- Session-pair rooms: `server/messaging/session-pairs.mjs`; `server/messaging/messages.mjs`
- MCP tools: `server/mcp-stdio.mjs`
- CLI `dm --to` / `sessions`: `server/cli/message-commands.mjs`
- Acceptance tests: `tests/session-principals.test.mjs`; `tests/addressed-send.test.mjs`
- ZCode launch config: `~/.zcode/cli/config.json`
- Current ZCode client identity (secret-bearing; never dump): `.vendor-lab/zcode-client-1/`
- Remote test CA: `.vendor-lab/tls/ca.pem`
- Release and install: `package.json`; `scripts/package-release.mjs`; `docs/rel1-runbook.md`
