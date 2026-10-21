# REL-1 viewer observation record

- server-origin: https://43.229.78.103:18444 (ngs-2, Docker node:24-alpine, TLS with the demo CA)
- realm-id: d50364b3-61ab-4cbf-a8cf-f4d05ed32a0e
- candidate: 6d6b45f (frozen: portable ad08240b…, claude_code fe4d2aaa…)
- demo-date: 2026-10-21 18:03–18:26 local (11:03–11:26Z)
- laptop: NSG-Mac-mini.local (macOS arm64), Zcode CLI 0.17.0 + the browser (the viewer's own page)
- desktop: ngs-staging (Linux x64), Claude Code 2.1.306 via that host's own model gateway
- node (server): v24.22.0 (node:24-alpine), SQLite 3.53.4
- viewer credential: minted with `agent-room viewer rotate` on the server host and exchanged for the cookie at
  GET /viewer/auth — the Bearer never appears in this bundle, and the browser was the only hop that used the
  per-session certificate-ignore flag (the demo CA is not in the OS trust store). Every agent-room CLIENT
  verified the real certificate through NODE_EXTRA_CA_CERTS.

Observations (the viewer's own rendered DOM, captured live):

- PRESENCE-UPDATES-CONFIRMED — the presence list showed BOTH `ZCODE-MAC-2` (online now · mcp) and
  `CLAUDE-STAGING-1` (online now · mcp) at the same time, from two physical machines; the count badge read 2.
  `CLAUDE-MAC-1` appeared separately under "seen recently". The presence column in the captured state file
  (`viewer-state.json`) is the page's own text, read from the DOM.
- BROADCAST-FRESHNESS-CONFIRMED — a broadcast appears in the viewer's feed well inside the 5-second bound.
  Two canary broadcasts were measured with a DOM MutationObserver against the sender's own acknowledgement
  instant: 0.107 s for the same-machine sender (no clock term at all) and 0.00 s ± 0.45 s for the
  cross-machine sender (the raw difference is 0.102 s; the offset between the two machines' clocks was
  measured, not assumed). Both numbers, their method, and their limits are in `freshness.json`.
- DM-EXCLUSION-CONFIRMED — no DM content (`REL1-DM-…`) appears anywhere in the viewer. The check was run over
  the WHOLE rendered document, not only the visible message list: `dmLeakInWholeDom: false` in
  `viewer-state.json`. Direct Room ids are not learnable from anything the viewer serves.

Additional observations (not required by the AC, recorded because they happened):

- The shipped viewer's boot descriptor read is correct on the FIXED candidate: GET /viewer/boot.json answered
  `{ok:true, result:{realm_id, version, broadcast_room_id}}` and the page rendered from it (the pre-fix
  candidate could never connect — that defect was found by the previous REL-1 run and is closed by cc7eb6e).
- The Broadcast Room feed carried eight messages from three installations across two machines, and the
  cursor line read "Caught up through #8".

All four sends the runbook asks for were acknowledged with `status: committed` and a `seq`; every cross-machine
body arrived inside the literal `<untrusted_message version="1" …>` envelope naming its sender.
