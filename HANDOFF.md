# agent-room Handoff (v1.1.0 Complete)

**Date:** 2026-11-23 · **Status:** Track 1 (`v1.0.1` `c4f2a6f`) + Track 2 (`v1.1.0`) Complete in `plugins/agent-room`; Track 3 (`tmux-teams` Phase E Cell 3) Complete on clean branch `feat/phase-e-cell-3` in `/Users/ngs/worktrees/tmux-teams-cell3`.

## 1. READ THIS FIRST

- **Repos & Isolation:**
  - `plugins/agent-room`: on `main` (`v1.1.0`), **unpushed**. Do **not** blindly `git add -A` in parent monorepo `/Users/ngs/agent-skills` (it has unrelated pre-existing staged KMS/topology changes and `plugins/agent-room` staged at stale `46ff0f0`).
  - `plugins/tmux-teams`: dirty `release/seat-advisors` (`63479ab`) was left **untouched**. Clean Cell 3 work lives in sibling worktree `/Users/ngs/worktrees/tmux-teams-cell3` (branch `feat/phase-e-cell-3` off `main` `a532b82`).
- **Verification Policy [directive]:** Unit-test sweeps (`node --test` / slow soaks) were retired in favor of targeted tests + fast Black-Box E2E + packager + `claude plugin validate --strict --json`, plus verifying `0` surviving `server/api/server.mjs` processes.
- **Interactive Visualization:** See [docs/agent-room-floorplan.html](docs/agent-room-floorplan.html) (refreshed post-Tracks 1–3; published via `artifact_sftp`).

## 2. WHAT LANDED IN v1.0.1 -> v1.1.0

1. **`v1.0.1` Stability, Leaks & Replay (`c4f2a6f`):**
   - **MCP Shutdown Spawn-Leak (`mcp-stdio.mjs`, `api-client.mjs`, `ensure-server.mjs`, `session-state.mjs`, `story-4-1-mcp-capabilities.test.mjs`, `shutdown-cleanup.test.mjs`):** Added shutdown `AbortSignal` fence before `spawn()`, unready child reaping prior to readiness handoff (without killing live shared daemons), `release()` joining in-flight `ensurePromise` / `sessionEnsurePromise`, test env `'off'` fixes, and one-shot stderr warning on unrecognized `AGENT_ROOM_SESSION_PRINCIPAL` values like `'0'`.
   - **PostCommitBus Backpressure (`post-commit-bus.mjs`, `watch.mjs`, `constants.mjs`):** Added `{ manualDrain: true }` opt-in so slow watch sockets keep byte accounting on the bus and trigger `slow_consumer` eviction; declared `WATCH_CURSOR_ROOM_MAX = 200` (`E3-A2`).
   - **Watch Cursor Replay & G3 Coalesce (`wait-commands.mjs`, `inbox.mjs`):** Passed `loadBaselineCursors()`, rebuilt `?cursors=...` dynamically on reconnect, tracked client-side `seen` + in-memory baseline advances, handled `rescan_required (catchup_limit)`, surfaced `last_error` + stderr on connection/TLS failure, and wired `coalesce()` (`TRAILING_COALESCE_MS = 150`, `E3-A1`) using `readLastInboxWakeAtMs()`.
   - **Bounded Dedup Retention (`bare-id-dedup.mjs`, `room-log.mjs`, `server.mjs`):** Added `pruneExpiredInTx` (`rowid` subquery <= 500) scheduled in `retentionPruneSafely` (`A1`).
2. **`v1.1.0` Standalone Onboarding & Real Boundary E2Es:**
   - **Raw-Clone `--install` / `--print` & TOML Quoting (`harness-installer.mjs`, `bootstrap-commands.mjs`, `README.md`, `story-5-1-installers.test.mjs`):** Standalone installs resolve `<package>/server/mcp-stdio.mjs`; plugin-mode installs (`CLAUDE_PLUGIN_ROOT` / bundles) keep `${PLUGIN_ROOT}`; proper TOML v1.0 literal/basic string parsing & quoting replaces `.replace(/'/g, '"')`.
   - **`allow` Session-Principal Resolution (`held-commands.mjs`):** Added `GET /api/session-principals` Source 3 so `agent-room allow <name>` resolves v1.0 principals without legacy `/api/presence` rows.
   - **`wait` Bootstrap Compatibility (`wait-commands.mjs`):** Accepts initialized `sessions/<scope>/session.json` principals alongside legacy `config.json`.
   - **MCP Transient `agent_id_taken` Recovery (`mcp-stdio.mjs`):** Transient occupancy conflicts no longer permanently brick/exit the MCP adapter; tools stay alive and re-acquire the name once free.

## 3. HOW TO VERIFY CLEANLY

```sh
TMP_PKG="$(mktemp -d /tmp/ar-pkg-XXXXXX)" && rm -rf "$TMP_PKG"
node scripts/package-release.mjs --out "$TMP_PKG"
claude plugin validate --strict --json "$TMP_PKG/agent-room-claude-code"
rm -rf "$TMP_PKG"
node --test tests/package.test.mjs tests/story-5-1-installers.test.mjs tests/story-4-1-mcp-capabilities.test.mjs tests/shutdown-cleanup.test.mjs
ps aux | grep 'server/api/server\.mjs' | grep -v grep || echo "LEAKS=0"
```

## 4. REMAINING KNOWN BOUNDARIES

- `1000 OS processes` and `1000 Bearers across >=4 actors` remain `not_qualified`.
- Claude Code `2.1.330` in `-p` mode does not emit client `capabilities.experimental['claude/channel']`, so `verifyClaudeChannel` honestly stays at `Channel-Ready, Host --channels Unverified`.
- `server.mjs` / `room-log.mjs` monolithic split (`epic-1-retro-item-6`) stays intentionally deferred (`in-progress`, rejected busywork).
