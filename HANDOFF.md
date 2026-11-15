# agent-room Handoff (v1.0.0-dev / Epic 1 Complete)

**Date:** 2026-11-16 · **Status:** Epic 1 COMPLETE (`done`), Epics 2–5 (`10` stories) `backlog` · **Next Step:** Story 2.1

## 1. READ THIS FIRST

- **Branch & Repo:** `feat/agent-room-v1.0` in child repo `plugins/agent-room` (Epic 1 code tip `6b409db`, **unpushed**; this `HANDOFF.md` commit sits directly on top; branch point over v0.9.0 handoff `1056089`). **Never** stage/commit inside the parent monorepo `../..` or commit gitignored `_bmad-output/`.
- **Do Next:** Implement **Story 2.1** (`_bmad-output/planning-artifacts/epics.md:225-246`): `GET /api/rooms` session/`ssession:` isolation, `cursors.json` v2 + `cursors.lock`, `agent-room read`, and non-destructive `dm` lease reuse (`rm finally DELETE`).
- **Verification Policy [directive]:** Unit-test sweeps (`node --test` / `rel3-soak.test.mjs`) are **retired by owner directive**. Verify every story with fast (`<20s`) isolated **Real Black-Box E2E** runs + `scripts/package-release.mjs` + `claude plugin validate --strict --json`, cleaning all temp dirs/PIDs afterward.
- **Sibling / Legacy Pointers:** Legacy v0.9.0 ZCode forensics live in git history (`git show handoff/agent-room-v090:HANDOFF.md` at `1056089`), `.vendor-lab/`, and `docs/rel1-runbook.md`. Sibling `../../plugins/tmux-teams` has uncommitted `oc-advisor` changes (`34/34` verified).

## 2. HOW TO VERIFY

Run from the `plugins/agent-room` root after resetting `$WORK` on every invocation. Clean `$WORK` and spawned processes before reporting done:

```sh
# 1. Dual Packaging + Claude Code Strict Plugin Schema Validation [measured]
TMP_PKG="$(mktemp -d /tmp/ar-pkg-XXXXXX)" && rm -rf "$TMP_PKG"
node scripts/package-release.mjs --out "$TMP_PKG"
claude plugin validate --strict --json "$TMP_PKG/agent-room-claude-code"
rm -rf "$TMP_PKG"

# 2. Sprint Planning Tracking Validation [measured]
uv run ../../.agents/skills/bmad-sprint-planning/scripts/sprint_plan.py validate \
  --status-file _bmad-output/implementation-artifacts/sprint-status.yaml

# 3. Cold Black-Box E2E: SessionStart hook -> bootstrap -> sessions -> dm -> clean stop [measured]
WORK="$(mktemp -d /tmp/ar-e2e-XXXXXX)"
cleanup_ar_e2e() {
  if [ -f "$WORK/shared/runtime.json" ]; then
    PID_SERV="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid)' "$WORK/shared/runtime.json" 2>/dev/null || true)"
    if [ -n "${PID_SERV:-}" ]; then
      kill -TERM "$PID_SERV" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        ! kill -0 "$PID_SERV" 2>/dev/null && break
        sleep 0.2
      done
      ! kill -0 "$PID_SERV" 2>/dev/null && echo "LEAKS=0" || echo "LEAK_PID=$PID_SERV"
    fi
  fi
  rm -rf "$WORK"
}
trap cleanup_ar_e2e EXIT
ENVF="$WORK/claude.env" && : > "$ENVF"
AGENT_ROOM_DATA_DIR="$WORK/shared" PLUGIN_DATA="$WORK/client" CLAUDE_ENV_FILE="$ENVF" \
  node server/cli/agent-room.mjs hook session-start </dev/null
set -a; . "$ENVF"; set +a
AGENT_ROOM_DATA_DIR="$WORK/shared" PLUGIN_DATA="$WORK/client" \
  node server/cli/agent-room.mjs bootstrap --harness claude --json
AGENT_ROOM_DATA_DIR="$WORK/shared" PLUGIN_DATA="$WORK/client" \
  node server/cli/agent-room.mjs sessions --json
# Read self address and send self-addressed loopback dm (outputs JSON without --json):
SELF_ADDR="$(node -e 'const fs=require("fs"),p=fs.readdirSync(process.argv[1])[0];console.log(JSON.parse(fs.readFileSync(process.argv[1]+"/"+p+"/session.json","utf8")).address)' "$WORK/client/sessions")"
AGENT_ROOM_DATA_DIR="$WORK/shared" PLUGIN_DATA="$WORK/client" \
  node server/cli/agent-room.mjs dm --to "$SELF_ADDR" --text "handoff-e2e-ping"
```

*(Note: `cleanup_ar_e2e` stops `$PID_SERV` via `$WORK/shared/runtime.json` because `server.mjs` argv has no `$WORK` marker; `LEAKS=0` proves `! kill -0 "$PID_SERV"` passed.)*

**Expected green baselines (verified on Epic 1 working copy):**
- `package-release.mjs` writes `agent-room-agent-plugin` + `agent-room-claude-code`; `claude plugin validate --strict --json` reports `success: true`, `errors: []`, `warnings: []`, `contents: []` (`ICON_MISSING` in `directory.findings` is non-blocking advice only). `[measured]`
- `sprint_plan.py validate` returns `{"ok": true, "valid": true, "problems": []}`. `[measured]`
- Cold E2E outputs `CLAUDE_ENV_FILE` `AGENT_ROOM_SESSION_SCOPE=<harness>-<16hex>`, `bootstrap` `ok: true`, `sessions` `locality: "local"` + `presence: "online"`, `dm` `ok: true` + `status: "committed"` + `committed_seq: 1`, and `LEAKS=0`. `[measured]` *(Side effect addressed in Story 2.1: running `dm` currently offlines the scoped session via `finally DELETE` at `server/cli/message-commands.mjs:765-772`.)*

## 3. STATE

- **Epic 1 Completed (`sprint-status.yaml:38-45`, `[measured]` / `[read]`):**
  - **Story `1.1` (`cb0f140`):** Bounded async `WriteQueue` (`server/store/write-queue.mjs:28,53`, constants at `server/constants.mjs:18-27`) with fair per-session batching and SQLite busy backoff; wired in `server/store/room-log.mjs:1746-1781`; retired post-auth `429` admission gates.
  - **Story `1.2` (`449c36e`):** Realm-unique active `Agent ID` & `session_principals` STRICT schema + indexes (`server/identity/session-principals.mjs:99-131,161-165`), atomic migration from v0.9.
  - **Fix (`248b2dc`):** Eliminated orphaned `server.mjs` / `mcp` / `roomd` child processes across test/server shutdown (`closeServerAndStore` `server/api/server.mjs:2890-2925`). Verified `[measured]` `800/800` unit+soak pass, `0` leaks.
  - **Story `1.3` (`7d8a9aa`, `3290a9c`):** Crash-safe resume, 4-case takeover, idempotent `retryTakeoverByRecoveryInTxImpl` (`server/identity/session-principals.mjs:405-411,510,628,784-816`; fix `3290a9c` guards already-occupied lease), HTTP routes (`server/api/server.mjs:1519,1827,1873,1902,1936`), and host-local `revoke` (`server/identity/session-principals.mjs:930-958`, `server/cli/session-principals-commands.mjs:26-120`).
  - **Story `1.4` (`e20dbc9`):** Zero-write live `GET /api/session-principals` directory bounded under `FRAME_MAX_BYTES` (`1_048_576`, `server/constants.mjs:11`, `server/api/server.mjs:1978-2013`), dual non-evicting pools (`SESSIONS_MAX=2048`, `CLI_SESSIONS_MAX=512`, `REMOTE_BEARER_SESSIONS_PER_ACTOR_MAX=256`, `server/constants.mjs:502-505`), bounded background retention prune (`500`/tick at `server/identity/session-principals.mjs:1088`, `server/api/server.mjs:2811-2832`), throttled bearer claim touch (`server/api/server.mjs:2696-2738`), and `agent-room sessions [--json]` with `locality: 'local'|'remote'` (`server/cli/message-commands.mjs:824-884`, `session-principals.mjs:1025-1083`).
  - **Story `1.5` (`6b409db`):** Skeleton `agent-room bootstrap` (`server/cli/bootstrap-commands.mjs:184-427`), 5-step scope binding (`server/client/session-state.mjs:164,259-303`), cold SQLite-free `SessionStart` hook (`hooks/hooks.json:1-14`, `server/cli/hook-session-start.mjs:143-221`), path-key traversal guard (`server/runtime.mjs:156`), `atomicWriteJson` (`server/runtime.mjs:179`), dual bundle packaging (`scripts/package-release.mjs:49-50,213-264`), plus `BOOTSTRAP.md` and `skills/agent-room/SKILL.md`.
- **Workspace & Machine State (`[measured]`):**
  - Clean tracked working tree in `plugins/agent-room`; single git worktree (`git worktree prune` and `.candidate-checkout` / `feat/noninteractive-agent-setup` removed; `.candidate-packages`, `.soak-world`, `.mailbox-out`, `.tmux-teams`, `.zcode/workflow-runs`, `/tmp` E2E dirs deleted; `0` swarm/verification PIDs remain).
  - Pre-existing host daemons intentionally untouched: `~/.agent-room/agent-room.sqlite`, `.vendor-lab/rel1-zcode-shared`, existing user `0.9.0` MCP adapters, `.vendor-lab/`, and `_bmad-output/` / `_bmad/` / `.agent/`.
  - Parent monorepo has pre-existing unrelated dirty changes in `../../plugins/tmux-teams` (`oc-advisor/SKILL.md`, `oc-advisor-policy.test.mjs`, `34/34` pass).
- **Remaining Backlog (`_bmad-output/implementation-artifacts/sprint-status.yaml:47-67`, `epics.md:221-474`, `0%` implemented `[read]`):**
  - **Epic 2:** `2.1` (Session room isolation, Cursors v2 + `cursors.lock`, `agent-room read`, `dm` lease reuse), `2.2` (Local Fast-Path vs Remote HTTPS direct send by bare Agent ID in single `SAVEPOINT`).
  - **Epic 3:** `3.1` (`PostCommitBus` + multiplexed `watch` NDJSON stream), `3.2` (Wake loop guard, two-phase wake, wake reset), `3.3` (`wait` over watch, inbox rotation, stale scope GC).
  - **Epic 4:** `4.1` (Verified Claude MCP Channel + passive notices), `4.2` (All 4 lifecycle hooks with Stop loop safety), `4.3` (Tier 3 `notify` command + full `doctor` matrix).
  - **Epic 5:** `5.1` (Cross-harness closed-enum installers + complete bundles), `5.2` (Fast E2E/release readiness qualification runner).

## 4. DO NOT

1. **DO NOT run full `node --test` or `tests/soak/rel3-soak.test.mjs` during normal story verification `[directive]`** — owner retired unit-test sweeps (`~800` tests took ~3–6 min and masked real E2E value); use fast `<20s` Real Black-Box E2E + packager + `claude plugin validate --strict`.
2. **DO NOT run `agent-room session-principals list` `[read]`** — `server/cli/session-principals-commands.mjs:78-83` rejects any subcommand except `revoke`; use `agent-room sessions [--json]` (`server/cli/message-commands.mjs:824`).
3. **DO NOT pass `--chat-id` to `agent-room bootstrap` or omit `--room` on current `agent-room read` `[read]`** — `parseBootstrapArgs` (`bootstrap-commands.mjs:69-98`) accepts only `--remote|--invite|--harness|--scope|--json`; `runReadFamilyCommand` (`message-commands.mjs:349-350`) requires `--room` until Story `2.1` replaces/extends it with `--peer`. *(Also `normalizeHarnessRole` at `bootstrap-commands.mjs:100-104` still accepts arbitrary strings until Story `5.1`.)*
4. **DO NOT keep `finally { DELETE /api/session-principals/current }` or `sessionCursorMemory` in Story 2.1 `[read]`** — `message-commands.mjs:765-772` currently deletes the scoped session's own lease on every `dm` exit, and `server/mcp-stdio.mjs:485` holds an in-process `Map` cache (`sessionCursorMemory`) that will drift from CLI `sessions/<scope>/cursors.json` v2 updates. Also move `CLIENT_REQUEST_TIMEOUT_MS` (`message-commands.mjs:58`) into `server/constants.mjs`.
5. **DO NOT route `Session` capabilities to `GET /api/rooms` without implementing Story 2.1 ACLs first `[read]`** — `SESSION_CAPABILITY_ROUTES` (`server/api/server.mjs:2655-2663`) currently excludes `/api/rooms`, and `listRooms` (`server/api/server.mjs:926-933`) lists by `actorFingerprint` only without separating `ssession:` vs `Bearer` (`read` must also never return `Held` `text` and must advance `read_seq` only after `stdout` flush under `cursors.lock`).
6. **DO NOT write to SQLite on hot-path `Session <capability>` read/status requests `[read]`** — keep `sessionCapabilityVerifier` (`server/api/server.mjs:2664-2762`) read-only; base leases renew strictly via `POST /api/session-principals/heartbeat` (`server/api/server.mjs:1873`).
7. **DO NOT bump `package.json`/`plugin.json` version without updating `expectedPluginManifest` `[read]`** — `scripts/package-release.mjs:28-35,213-225` hardcodes `version: '0.9.0'` and fails `validateCanonicalManifests` on mismatch. Never create repo-root `.claude-plugin/` (generated only inside `--out/agent-room-claude-code` at `L254-257`), and never pass an existing `--out` dir (`package-release.mjs` requires a non-existent absolute path).
8. **DO NOT stage parent monorepo files, touch live host daemons, or add npm runtime deps/web mutators `[read]`** — `AGENTS.md:9-13` mandates zero runtime npm deps, GET-only viewer, and server-derived actor identity; `../..` contains unrelated dirty files.
9. **DO NOT rely on `oc-advisor` on this host `[read]`** — `$HOME/.config/opencode/tool/mgrep.ts:2` imports `@opencode-ai/plugin`, which fails to resolve on this machine.

## 5. DECIDED — DO NOT RELITIGATE

- **SQLite & Overload Guarantees:** `STRICT`, `WAL`, `synchronous=FULL`, single-writer `WriteQueue` (`server/store/write-queue.mjs:53`) + fair batching + busy backoff (`constants.mjs:18-27`); non-evicting session pools (`2048`/`512`/`256`, `constants.mjs:502-505`) fail closed with `503 queue_full` rather than dropping active sessions; zero post-auth `429` admission gates.
- **Session Lifecycle & Auth Separation:** Host-local `session-principals revoke` works offline/immediately (`session-principals.mjs:930-958`); `45s` base lease / `15s` heartbeat (`constants.mjs:696`); idempotent takeover recovery ticket window is `CONFLICT_TICKET_TTL_MS = 60_000` (`constants.mjs:634`, checked by `withinRecoveryWindow` at `session-principals.mjs:405-411`); bounded background retention prune (`500` rows/tick every `5m`, `30d` TTL + `1h` grace, `constants.mjs:699,780-782`); `Bearer` claim touch throttled to `60s` (`constants.mjs:779`, `server.mjs:2696-2738`).
- **Scope Resolution & Addressing:** 5-step scope order (`--scope` > `AGENT_ROOM_SESSION_SCOPE` > hashed host session ID > `scope-bindings.json` > `p<ppid>.<pid>`, `session-state.mjs:259-291`); `SessionStart` uses `O_NOFOLLOW` + dedup on `CLAUDE_ENV_FILE` with zero `node:sqlite` import (`hook-session-start.mjs:143-221`). Full addresses require `~` (`*~*@*`, `session-principals.mjs:123`) vs bare `Agent ID`; `enrolled_via` determines `local` vs `remote` locality (`session-principals.mjs:1078`).
- **Process & Release Boundaries:** Epics `1–5` specs are fixed via `/requirement-audit` (`epics.md:86-474`); `PostCommitBus` is intentionally omitted until Story `3.1` (`epics.md:260`). Single packager builds both `agent-room-agent-plugin` and `agent-room-claude-code` (`scripts/package-release.mjs:227-264`).

## 6. UNPROVEN

- **Full legacy test suite on Stories `1.4` & `1.5`:** Full ~800-test `node --test` + `tests/soak/rel3-soak.test.mjs` passed cleanly at `1.3` (`800/800`), then was **not run** on `e20dbc9` or `6b409db` per owner directive retiring unit tests.
- **Epics `2–5` (`10` stories, `epics.md:221-474`):** Zero implementation yet for session room isolation, Cursors v2/`cursors.lock` contention, `agent-room read`, non-destructive `dm` reuse, bare-ID `SAVEPOINT` routing & 1,000-op burst budget, `PostCommitBus`/`watch`, wake guards/hooks/MCP Channel/`doctor`, closed-enum installers, and release qualification runner.
- **Live Interactive Harness Environments:** Live ZCode multi-client round-trip (per v0.9.0 handoff) and interactive multi-pane Claude Code `SessionStart` hook execution across real terminal sessions were not tested live on `6b409db` (verified via isolated headless E2E subshells only).
- **Architecture Spine Sync:** Both tracked v0.9 spine (`docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md`) and gitignored v1.0 spine (`_bmad-output/planning-artifacts/architecture/architecture-agent-room-2026-11-15/ARCHITECTURE-SPINE.md`) exist on disk; future story amendments (`AD-8`, etc.) must check which copy is authoritative before release merge.
- **Sibling / Host Tooling:** Parent monorepo `../../plugins/tmux-teams` `oc-advisor` edits remain uncommitted (`34/34` tests pass), and `$HOME/.config/opencode/tool/mgrep.ts` `@opencode-ai/plugin` dependency on the host stays unresolved.

## 7. WHERE THINGS LIVE

- **Specs & Planning (gitignored except docs/):** `_bmad-output/planning-artifacts/epics.md` · `_bmad-output/implementation-artifacts/sprint-status.yaml` · `_bmad-output/planning-artifacts/architecture/architecture-agent-room-2026-11-15/ARCHITECTURE-SPINE.md` · `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md` · `AGENTS.md` · `BOOTSTRAP.md` · `skills/agent-room/SKILL.md`
- **Core Server & Store:** `server/constants.mjs` · `server/runtime.mjs` · `server/store/write-queue.mjs` · `server/store/room-log.mjs` · `server/identity/session-principals.mjs` · `server/api/server.mjs` · `server/api/routes.mjs` · `server/api/pipeline.mjs`
- **Client State, MCP & Hooks:** `server/client/session-state.mjs` · `server/client/cursors.mjs` · `server/client/api-client.mjs` · `server/client/ensure-server.mjs` · `server/client/trust.mjs` · `server/client/held.mjs` · `server/client/remote-config.mjs` · `server/mcp-stdio.mjs` · `hooks/hooks.json` · `server/cli/hook-session-start.mjs`
- **CLI Commands:** `server/cli/agent-room.mjs` · `server/cli/bootstrap-commands.mjs` · `server/cli/session-commands.mjs` · `server/cli/session-principals-commands.mjs` · `server/cli/message-commands.mjs`
- **Packaging & Manifests:** `scripts/package-release.mjs` · `package.json` · `plugin.json` · `mcp.json`
