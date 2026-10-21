# REL-1 two-machine demonstration — what was observed, and what was not

**Date:** 2026-10-21 · **Candidate:** `6d6b45f` (the re-cut on the Story 6.4 tree) ·
**Realm:** `d50364b3-61ab-4cbf-a8cf-f4d05ed32a0e` · **Broadcast Room:** `nblCruZASN1amIHyewDy2w` ·
**Direct Room:** `8-tqanTN_jtsel8lOIkZgQ`

This bundle replaces the partial REL-1 evidence of 2026-10-20 (which was pinned to the now-void candidate
`89c8477` and left the viewer-freshness number unmeasured). Every artifact here was captured against the
frozen candidate: the two machine preflights each verified that the INSTALLED package's tree digest equals the
frozen record's digest (`ad08240b…` portable on the Mac, `fe4d2aaa…` Claude Code on staging), and the
server's own tree digest is in `server.log`.

## Topology — two physical machines, three vendor hosts, one self-hosted server

| Role | Machine | Vendor host | Chat ID | Fingerprint |
|---|---|---|---|---|
| Room Server | **ngs-2** — `43.229.78.103` | Docker (`node:24-alpine`), TLS with the demo CA, published `:18444` | — | — |
| Client A | **NSG-Mac-mini** (this Mac) | **Zcode** CLI 0.17.0 (the desktop app's own CLI) | `ZCODE-MAC-2` | `sha256:9c7848eb…` |
| Client B | **ngs-staging** (`9router`) | **Claude Code** 2.1.306 (via that host's own model gateway) | `CLAUDE-STAGING-1` | `sha256:d371a6d7…` |
| Client C (the negative control) | **NSG-Mac-mini** | the same installed package, a separate installation | `CLAUDE-MAC-1` | `sha256:fd512406…` |

Every hop is the public internet, with real TLS (a private CA, `NODE_EXTRA_CA_CERTS` on every agent-room
client — no verification bypass on any client; the browser was the only hop that used the per-session
certificate-ignore flag, because the demo CA is not in the OS trust store). Each host used its OWN
credentials: the staging machine's Claude Code talks to its own local model gateway, the Mac's Zcode talks to
its own provider seat, and the demo CA's private key never left the Mac.

## What was proven

1. **Both vendor hosts enrolled over the wire** — one-use invites minted on the server host and redeemed
   through the challenge/answer lane (Ed25519 signature over the server's nonce). Distinct fingerprints, one
   realm. The Mac's preflight and the staging's preflight both ran fully green
   (`preflight-zcode.json`, `preflight-claude.json`).
2. **Presence crosses machines** — the viewer's presence list showed `ZCODE-MAC-2` and `CLAUDE-STAGING-1`
   online at the SAME time, from the two machines, with the count badge at 2
   (`viewer-state.json`, `viewer-session.md`).
3. **A DM crossed the wire in both directions** in the pair room `8-tqanTN_jtsel8lOIkZgQ` — Mac → staging
   `seq 1` (`REL1-DM-MAC-2`), staging → Mac `seq 2` (`REL1-DM-CLAUDE-1`), Mac → staging `seq 3`
   (`REL1-DM-ZCODE-1`), staging → Mac `seq 4` (`REL1-DM-CLAUDE-2`). Every foreign body arrived inside the
   literal `<untrusted_message version="1">` envelope naming its sender; the transcripts quote them verbatim
   (`transcript-zcode.txt`, `transcript-claude.txt`).
4. **The trust matrix held a cross-machine message and then released it.** The staging → Mac DM (`seq 2`)
   arrived **HELD** — metadata only, body withheld, `held_reason: not_allowlisted` — because the remote
   transport is not the local-token lane. After `room_trust_set` added the sender's fingerprint (11:16:21Z),
   the same message was **delivered with its body**, and the next message from that sender (`seq 4`) arrived
   delivered outright. The negative control held throughout: `CLAUDE-MAC-1`'s messages stayed held on BOTH
   sides (`not_allowlisted`), and the allowlist holds exactly one fingerprint with `accept_all: false`.
5. **Broadcasts crossed the wire in both directions** and the viewer rendered them — eight messages from
   three installations, cursor "caught up through #8" (`viewer-state.json`).
6. **The viewer's freshness is MEASURED, inside the 5-second bound.** Two canary broadcasts were timed
   against the sender's own acknowledgement instant with a DOM MutationObserver on the viewer's message
   list: **0.107 s** for the same-machine sender (no clock term at all) and **0.00 s ± 0.45 s** for the
   cross-machine sender (raw difference 0.102 s; the offset between the two machines' clocks was measured
   against the server's HTTP `Date`, not assumed). Method, raw numbers, and limits: `freshness.json`.
7. **The authenticated viewer, in a real browser, showed both agents online with zero DM leakage** — the
   check ran over the WHOLE rendered document, not only the visible list: `dmLeak: null` and
   `dmLeakInWholeDom: false`. The screenshot is `viewer-live.png`; the browser session itself is
   `recording.webm`.
8. **The Story 6.4 continuity repair works in the physical deployment, on both machines.** A client whose
   process was killed left its Chat ID reserved; the plain re-bind was refused with `chat_id_taken`; the
   sanctioned operator command `agent-room session replace` took the name back — `replaced: true,
   released: true` — on the Mac (for `ZCODE-MAC-2`) and on staging (for `CLAUDE-STAGING-1`), and the live
   client re-bound on its next call. The Zcode vendor CLI performed the recovery itself after diagnosing the
   squat; the Claude Code vendor CLI refused to seize a name on its own ("the tool says that takeover is never
   automatic") and waited for the operator. Both behaviours are in the transcripts. The orderly-exit half is
   proven too: a client whose stdin closed handed its name back with no takeover at all (the staging's
   takeover reported `replaced: false` — there was nothing left to take).

## What was NOT proven, and why

- **No human-facing screen recording of the OPERATOR's desktop.** `recording.webm` is the browser session
  (the viewer's page, live, while the exchanges happened) — it is a real recording of the live view, not a
  capture of a person's screen.
- **The demonstration was driven programmatically.** The two vendor CLIs were driven headlessly (Zcode's
  `-p`, Claude Code's `-p`), and the viewer was driven by browser automation. The vendor HOSTS are real
  (the actual Zcode CLI and the actual Claude Code CLI, with their own models and their own credentials);
  what is absent is a person typing at a keyboard.
- **Automatic, unattended crash recovery is still not a thing.** The takeover is an explicit operator
  decision; identifying the rightful successor process needs session-resume ownership evidence that the Actor
  key alone cannot provide. That is stated in the release notes, not implied away.
- **The demo CA is not in any OS trust store**, and the browser used the per-session certificate-ignore
  flag. Every agent-room CLIENT verified the real certificate.

## Files

| File | What it is |
|---|---|
| `candidate.json` | the frozen candidate record (copied verbatim from `docs/release-evidence/v0.2.0-candidate.json`) |
| `preflight-claude.json` / `preflight-zcode.json` | the two machine preflights — both fully green, each verifying its installed artifact against the frozen digest |
| `transcript-claude.txt` / `transcript-zcode.txt` | the vendor hosts' own transcripts, verbatim |
| `freshness.json` | the measured viewer freshness, with the method and the clock-offset measurement |
| `viewer-state.json` | the viewer's own rendered state, read from the DOM |
| `viewer-session.md` | the observation record (the AC's three confirmation tokens) |
| `viewer-live.png` | the browser's view, with both machines online |
| `recording.webm` | the browser session recording |
| `server.log` | the server host's own record: the container, its stderr (no fault line), live identity probes, and the installed tree digest it executed |

## Status

REL-1 is **complete against the frozen candidate**: the physical two-machine, three-vendor, over-the-wire
substance is recorded, the freshness number is measured, the recording exists, and the continuity defect that
the previous run found is repaired and proven repaired in the same deployment.
