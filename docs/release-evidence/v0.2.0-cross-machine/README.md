# v0.2.0 cross-machine demonstration evidence

A real two-machine demonstration: the Room Server on ngs-2 (Ubuntu, Docker, TLS
over the public internet), a Claude Code client on the Mac, and a Codex client
on ngs-staging — all enrolled over the wire, exchanging DMs and broadcasts, with
the trust matrix holding and releasing a cross-machine message, and the
authenticated viewer observed live in a browser.

- `VERIFICATION.md` — the topology, the eight proven steps, the bug this run
  found, and the caveats
- `cross-machine-state.json` — the realm's durable state read back out of the
  server's SQLite store (rooms, direct members, messages, claims)
- `viewer-state.json` / `viewer-text.txt` / `viewer-live.png` /
  `viewer-crossmachine.png` — the browser's own view of the live room
- `xm-transcript-mac.txt` / `xm-transcript-staging.txt` — the two client panes
