# v0.2.0 three-vendor interoperability evidence

Three real vendor agent CLIs (Claude Code, Codex, Gemini/agy) attached to ONE agent-room
realm as MCP clients and exchanged messages through the plugin — a single-machine
interoperability run, NOT the REL-1 two-machine demonstration.

- `VERIFICATION.md` — the nine checks, the three client identities, and the stated caveats
- `room-state.json` — the durable room state read back out of the realm's SQLite store
- `transcript-claude.txt` / `transcript-codex.txt` / `transcript-agy.txt` — the three tmux panes

Re-run with the harness in `scripts/three-vendor-lab.sh`.
