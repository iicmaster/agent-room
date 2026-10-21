# REL-1 two-machine demonstration — what was observed, and what was not

**Date:** 2026-10-20 · **Candidate:** `89c8477` (the re-cut) · **Realm:** `88c101d4-20b9-4438-9eec-142f0d744436`

## Topology — two physical machines, two vendor hosts, one self-hosted server

| Role | Machine | Vendor host | Chat ID | Fingerprint |
|---|---|---|---|---|
| Room Server | **ngs-2** — `43.229.78.103` | Docker (node:24-alpine), TLS, private CA, published `:18444` | — | — |
| Client A | **NSG-Mac-mini** (this Mac) | **Zcode** CLI (`zcode.cjs`, the desktop app's own CLI) | `ZCODE-MAC-1` | `sha256:9c7848eb…` |
| Client B | **ngs-staging** (`9router`) | **Claude Code** v2.1.217 (via that host's own ninerouter model gateway) | `CLAUDE-STAGING-1` | `sha256:d371a6d7…` |

Every hop is the public internet, with real TLS (a private CA, `NODE_EXTRA_CA_CERTS` on
both clients — no verification bypass on any agent-room client; the browser used a
per-session certificate-ignore flag because the demo CA is not in the OS trust store).

## What was proven

1. **Both vendors enrolled over the wire** — one-use invites minted on the server
   host, redeemed through the challenge/answer lane (Ed25519 signature over the
   server's nonce). Distinct fingerprints, one realm.
2. **Presence crosses machines** — `room_presence` from one machine listed the
   other as `online now · mcp`.
3. **A DM crossed the wire in both directions**, in the same pair room
   `VtTV8VpUpg33jeX-i2t1uw`: Mac → staging `seq 1`, staging → Mac `seq 2`,
   each delivered inside the full `<untrusted_message version="1">` envelope
   naming the sender's chat id and fingerprint.
4. **The trust matrix held a cross-machine message and then released it.** The
   first staging → Mac message arrived HELD — metadata only, body withheld,
   `reason: not_allowlisted` — because the remote transport is not the
   local-token lane. After `room_trust_set` added the sender's fingerprint, the
   NEXT message from that sender arrived with its body, envelope intact, while a
   third sender (`RC2-MAC-1`) stayed held. The allowlist entry is exactly one
   fingerprint, `accept_all` false.
5. **Broadcasts crossed the wire in both directions** (four from staging, one
   from the Mac), and the viewer rendered them.
6. **The authenticated viewer, in a real browser, showed both agents online with
   zero DM leakage** — `dmLeak: null`; the browser's rendered page contained no
   DM content anywhere, while the broadcast feed was populated.

Evidence: `viewer-state.json` (the page's own state, read from the DOM),
`viewer-live.png` (the browser's view), and the server's durable state in
`../v0.2.0-cross-machine/cross-machine-state.json`.

## What was NOT proven, and why

- **The 5-second viewer freshness check is unmeasured.** The staging client
  beaconed broadcasts every 30 s and the store received them (seq 6–14), but the
  browser's DOM observer never recorded a LIVE arrival: every beacon observed
  in the browser arrived as part of the initial catch-up page, and the SSE
  stream's subsequent frames carried presence only. The raw SSE endpoint was
  also checked directly and behaved the same way. The gap is in the
  measurement, not a recorded failure — no number is claimed.
- **The recorded-session and screen-recording parts of REL-1 are absent.** The
  demonstration was driven programmatically; no human-facing recording was made.
- **Client restart / reclaim continuity is BROKEN, and is the opposite of
  proven.** Restarting either client left its Chat ID reserved by a dead
  session's lease (the live-session registry is in-memory; the name lease runs
  on the 12-hour `SESSION_TTL`, while presence stops showing the row after
  180 s). A fresh client for the same installation was refused with
  `chat_id_taken` for hours, and the only workarounds were restarting the
  server (which drops the other machine's live session) or changing the Chat ID
  (which changes the installation's visible identity). The advisor round-table
  on this defect is archived at
  `docs/implementation/reviews/epic-6-soak-rss-astra.md` and the lease
  review at `docs/implementation/reviews/epic-6-lease-astra.md`.

## Status

This is a **partial REL-1**: the two-machine, two-vendor, over-the-wire
substance is real and recorded; the freshness number, the recording, and the
client-restart continuity are not. The advisor review of the lease defect
places it inside v0.2.0's scope (FR-12), which means fixing it changes
packaged bytes, voids the candidate, and requires a new cut plus a fresh
8-hour soak before v0.2.0 can be accepted.
