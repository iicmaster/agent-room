# Candidate re-cut preflight — the packaged viewer in a real browser

**Date:** 2026-10-20 · **Candidate:** `89c8477` (version `0.2.0`) · **Server:** ngs-2, Docker, TLS

The advisor review of the viewer fix asked for one bounded check before the
eight-hour soak: the MATERIALIZED candidate's viewer, loaded in a real browser,
reaching its live state. The shipped viewer had never run against the shipped
API shape — that is how the envelope bug survived — so the check runs the
artifact, not the repository tree.

## What was run

1. The candidate was materialized with `scripts/package-release.mjs` and the
   resulting `agent-room-claude-code` package was deployed to ngs-2 and started
   in Docker with TLS. `GET /health` answered
   `{"ok":true,"result":{"version":"0.2.0"}}` — the stamped version, from the
   artifact.
2. The deployed `web/app.js` was confirmed to carry the fix (the envelope read).
3. The viewer token was minted on the server host, the Bearer→cookie bridge
   exchanged it for a session cookie, and the page was loaded in a real
   browser at `https://43.229.78.103:18444/viewer/`.
4. A real Claude Code client (`RC2-MAC-1`) was enrolled over the wire against
   the new realm and posted one broadcast.

## The observations

| Observation | Value |
|---|---|
| Viewer connection state | `Live` |
| Notice element | empty (no error) |
| Presence count | `1` |
| Presence list | `RC2-MAC-1` — `online now · mcp` |
| Broadcast messages rendered | `1` — `RC2-PREFLIGHT: broadcast from the re-cut candidate` |
| DM content in the DOM | none (`dmLeak: null`) |

The page reached its live state on the FIRST load after the cookie — no
"Room server unreachable", no retry loop. The same page against the previous
candidate reported unreachable on every load, which is how the bug was found.

Evidence: `rc2-viewer-preflight.png` (the browser's own view) and
`rc2-viewer-preflight.json` (the page's rendered state, read from the DOM).

## Caveats

- The browser was launched with a per-session certificate-ignore flag (the demo
  CA is not in the operating system's trust store). Every agent-room CLIENT
  used the real CA with full verification; the flag affects the browser only.
- The full live viewer proof — the physical two-machine demo, the recorded
  session — remains REL-1's scope and is not claimed here.
