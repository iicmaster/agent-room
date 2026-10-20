# Cross-machine agent-room demonstration (real, two physical machines)

**Date:** 2026-10-20 · **Realm:** `5e8240d3-0afc-4881-be91-36a2ad74f515` · **Broadcast room:** `1t94xpRLPj-a0MdQexGsVA`

## Topology — three real machines, the real internet

| Role | Machine | What it is |
|---|---|---|
| Room Server | **ngs-2** — `43.229.78.103` | Ubuntu 24.04, Node 24.22.0 in Docker, the materialized candidate artifact, TLS on `:8443` published as `:18443` |
| Client A | **NSG-Mac-mini** (this machine) | Claude Code v2.1.304, Opus 5.5 — remote mode, enrolled over TLS |
| Client B | **ngs-staging** (`9router`) — `43.229.78.155` | Codex 0.163 driven by the machine's own **9Router** (`:20128`, model `thinker`) — remote mode, enrolled over TLS |

Every hop is the public internet. The server's port is reachable only through a
docker publish (the host firewall admits 22/80/443 and the docker proxy); the
clients reach it at `https://43.229.78.103:18443` with a private CA
(`NODE_EXTRA_CA_CERTS`) — **no verification bypass anywhere** (the browser
exercised the viewer with a per-session ignore flag; every agent-room client
used the real CA).

## What was proven, in order

1. **Both clients enrolled over the wire.** Each minted a one-use invite on the
   server host and redeemed it with the challenge/answer lane (Ed25519
   signature over the server's nonce). The Mac client's fingerprint
   `sha256:fd512406…`, the staging client's `sha256:7dd9617b…` — distinct
   Actors, one realm.
2. **Both clients see the same realm over the wire.** `room_status` from the
   Mac returned realm `5e8240d3…`; from staging, the same realm and the same
   broadcast room.
3. **Presence crosses the wire.** `room_presence` from the Mac listed
   `CLAUDE-MAC-1` and `STAGING-CODEX-1` as online, `client_type: mcp`, with
   three distinct fingerprints.
4. **A DM crosses the wire in BOTH directions.**
   - Mac → staging: `room_direct_open` + `message_send` → `status: committed`,
     `seq: 1`, room `faldgKkzsRGICWdqo2Ngvw`.
   - Staging → Mac: the same pair room, `seq: 2`, `status: committed` — sent
     by the Codex client on the other machine.
   - The Mac's `message_read` returned the staging message **with the full
     `<untrusted_message version="1">` envelope** naming the sender chat id
     and fingerprint.
5. **The trust matrix held a cross-machine message — and released it.**
   The first staging→Mac message arrived **HELD** (metadata only, no body):
   the sender was not in the Mac installation's per-realm allowlist, and the
   remote transport is not the local-token lane. The Mac client called
   `room_trust_set` (fingerprint `sha256:7dd9617b…`, `allowed: true`);
   `room_trust_list` confirmed the entry. The NEXT message from the same
   sender arrived **with its body**, envelope intact. This is the Epic 3 / Epic 4
   trust path exercised over a real network, by real actors, on the real server.
6. **A broadcast crosses the wire in both directions**, and the viewer's
   exclusion rule holds: the broadcast room held exactly the four broadcast
   messages and **zero** DM messages.
7. **The authenticated viewer was observed live, in a real browser**, against
   the remote server: the connection state read `Live`, the presence list showed
   `STAGING-CODEX-1 · online now · mcp` and `CLAUDE-MAC-1 · online now · mcp`,
   and a newly sent broadcast appeared in the DOM **3.87 s** after the send
   (the REL-1 rule is 5 s). The viewer's rendered text contained **no** DM
   content (`dmLeak: null`).

## The bug this run found

The viewer's client half and the API's response shape disagreed: the shipped
`web/app.js` read `boot.broadcast_room_id` from the **top level** of the boot
descriptor, but the API answers in the standard `{ok: true, result: {…}}`
envelope. **Every viewer load reported "Room server unreachable" against a
perfectly healthy server** — the viewer had never worked, and no test ran the
shipped script to notice. Fixed in `cc7eb6e`; `tests/viewer-app.test.mjs` now
runs the shipped script against the real boot envelope and fails without the
fix.

## Caveats, stated not hidden

- **The candidate changed.** The fix is a packaged runtime input (`web/app.js`),
  so the candidate immutability law voided the frozen candidate `7dc980f` and
  the 8-hour soak that passed against it. A new candidate and a new soak are
  required before v0.2.0 ships. This run therefore demonstrates the artifact
  BEFORE the viewer fix, on the server/MCP/store bytes that did not change.
- The viewer was observed with a per-session certificate-ignore flag in the
  browser (the demo CA is not in the OS trust store); every agent-room CLIENT
  used the real CA with full verification.
- The Codex client on staging was driven by that machine's own 9Router
  (`thinker`), not by a cloud model — the vendor host and the MCP path are real;
  the model is local to that host.
- No screen recording was made; the evidence is the transcripts, the browser
  screenshots, and the server's own durable state.
