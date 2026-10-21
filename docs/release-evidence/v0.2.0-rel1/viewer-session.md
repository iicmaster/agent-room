# REL-1 viewer observation record

- server-origin: https://43.229.78.103:18444 (ngs-2, Docker node:24-alpine, TLS with the demo CA)
- realm-id: 308fb41d-f0f8-4b22-b9b6-78bc0f3723ed
- broadcast-room: Fryr4-D5xCFHxJfL90nQ5g · direct-room: fhbozmHGAEufqbuoY5UuzA
- candidate: 3929cc7 (frozen: portable 3d90129b…, claude_code e481c9a4…)
- demo-date: 2026-10-21 19:40–20:12 local (12:40–13:12Z)
- laptop: NSG-Mac-mini.local (macOS arm64), Zcode CLI 0.17.0 + the browser (the viewer's own page)
- desktop: ngs-staging (Linux x64), Claude Code 2.1.306 via that host's own model gateway
- node (server): v24.22.0 (node:24-alpine), SQLite 3.53.4
- viewer credential: minted with `agent-room viewer rotate` on the server host and exchanged for the cookie at
  GET /viewer/auth — the Bearer never appears in this bundle, and the browser was the only hop that used the
  per-session certificate-ignore flag (the demo CA is not in the OS trust store). Every agent-room CLIENT
  verified the real certificate through NODE_EXTRA_CA_CERTS.

Observations (the viewer's own rendered DOM, captured live):

- PRESENCE-UPDATES-CONFIRMED — the presence list showed BOTH `ZCODE-MAC-2` (online now · mcp) and
  `CLAUDE-STAGING-1` (online now · mcp) at the same time, from two physical machines; the count badge read 2
  and `CLAUDE-MAC-1` sat separately under "seen recently". The presence column in the captured state file
  (`viewer-state.json`) is the page's own text, read from the DOM, and the staging machine's own client
  heartbeat (in the run's transcript) shows the same two rows with their session timestamps.
- BROADCAST-FRESHNESS-CONFIRMED — a broadcast appears in the viewer's feed well inside the 5-second bound.
  Two canary broadcasts were measured with a DOM MutationObserver against the sender's own acknowledgement
  instant: 0.150 s for the same-machine sender (no clock term at all) and 0.276 s for the cross-machine sender
  (the raw difference is 0.172 s and the measured clock offset between the two machines adds 0.104 s; the
  offset between each machine and the server was measured against the server's HTTP Date, not assumed, and
  carries up to about +/-0.9 s of quantization uncertainty). Both numbers, their method, their endpoints and
  their limits are in `freshness.json`.
- DM-EXCLUSION-CONFIRMED — no DM content (`REL1-DM-…`) appears anywhere in the viewer. The check was run over
  the WHOLE rendered document, not only the visible message list: `dmLeak: null` and
  `dmLeakInWholeDom: false`.

Additional observations (not required by the AC, recorded because they happened):

- The shipped viewer's boot descriptor read is correct on the FIXED candidate: GET /viewer/boot.json answered
  `{ok:true, result:{realm_id, version, broadcast_room_id}}` and the page rendered from it (the pre-fix
  candidate could never connect — that defect was found by the FIRST REL-1 run and is closed by cc7eb6e).
- The Broadcast Room feed carried four messages from three installations across two machines, and the cursor
  line read "Caught up through #4".
- The observer was attached BEFORE the first broadcast, so all four recorded arrivals are live SSE arrivals:
  none of them is a catch-up render.

All four sends the runbook asks for were acknowledged with `status: committed` and a `seq`; every cross-machine
body arrived inside the literal `<untrusted_message version="1" …>` envelope naming its sender.
