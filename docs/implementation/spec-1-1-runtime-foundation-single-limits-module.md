---
title: 'Runtime foundation & single limits module'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: '8e9511857a0a989ca4d079c46da08361b291aed9'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/docs/implementation/epic-1-context.md'
  - '{project-root}/AGENTS.md'
warnings: ['oversized']
deferred:
  - summary: >-
      AGENTS.md runtime-floor text is stale (says Node >=24 / pitfall "Node < 24") after the 24.15 gate landed.
    evidence: |-
      AGENTS.md is inside the bmad-managed block that template refreshes overwrite; editing it here would be lost on refresh. Recorded for the next bmad refresh or manual edit.
    location: >-
      AGENTS.md
    severity: low
  - summary: >-
      SSE keep-alive cadence divergence: constants declare the AD-9 30 s value while v0.1 roomd still emits 15 s comments inline.
    evidence: |-
      The Code Map forbade behavior change this story; the SSE consumer arrives with the HTTP API work in Story 1.3, which must reconcile the live cadence with SSE_KEEP_ALIVE_SECONDS.
    location: >-
      server/roomd.mjs SSE comment interval
    severity: low
  - summary: >-
      ensureDaemon swallows a spawned server's gate failure (caller sees daemon_start_failed after the 5 s wait instead of the gate message).
    evidence: |-
      Pre-existing v0.1 spawn behavior (stdio ignored); direct launch and import paths surface the gate correctly. The ensureServer evolution in Stories 1.3/1.4 must pipe gate stderr through.
    location: >-
      server/daemon-client.mjs ensureDaemon
    severity: low
---

<intent-contract>

## Intent

**Problem:** v0.1 scatters its numeric limits across four files (`MAX_FRAME_BYTES`, `MAX_TOOL_TEXT`, `DATABASE_LIMITS`, `MAX_WAIT_MS`), has no Actor keypair or canonical fingerprint, gates only "Node major ≥ 24" instead of the ratified ≥ 24.15 floor, and ships no dependency audit. Every later v0.2 story (store v2, HTTP API, presence, MCP tools) would inherit this drift.

**Approach:** Build the load-bearing foundation of Epic 1 in place: one constants module owning every AD-9 limit and the PUBLIC_ERRORS→HTTP-status table; tightened startup gates asserted by every entrypoint; one Ed25519 keypair per installation with the canonical `sha256:`-prefixed fingerprint; hardened path/permission handling; and a static zero-external-dependencies check. Existing v0.1 modules re-point to the constants module; no behavior change beyond the tightened gate.

## Boundaries & Constraints

**Always:** every limit and every error's HTTP status is imported by name from the single constants module — no numeric limit restated anywhere in `server/` or `tests/`; the Actor fingerprint is `sha256:` + lowercase hex of SHA-256 over the raw 32-byte public key (never SPKI-DER); keypair files are regular non-symlink 0600 inside 0700 dirs, size-bounded; all entrypoints (`mcp-stdio`, `roomd`) run the runtime gate before any other work and exit non-zero with a stderr message naming the failed gate and the offending version; changes to v0.1 behavior in this story are limited to the tightened Node gate and limit consolidation.

**Block If:** an invalid or unreadable keypair file is found and regeneration would silently change the Actor identity (never auto-regenerate — refuse to start); `process.versions` proves non-mutable so the entrypoint-exit test cannot be written without a test-only backdoor in production code; the environment's real Node < 24.15 or SQLite < 3.51.3 (fix the environment first — do not weaken the gate).

**Never:** no HTTP server, route, or middleware work (Story 1.3); no schema v2 or store changes beyond re-pointing constants (Story 1.2); no new MCP tools or wire changes (Story 1.7); no unix-socket retirement (Story 1.3+); no external npm dependencies; the private key never appears in logs, tool output, wire captures, or test fixtures; no placeholder identities, no `TODO` identity stubs anywhere.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| fresh keypair | empty PLUGIN_DATA, initialize keys | private key file 0600 regular non-symlink size-bounded; fingerprint `sha256:<64 lowercase hex>` returned; private key bytes never returned | No error expected |
| keypair reload | same PLUGIN_DATA, restart process | identical fingerprint; key file unchanged; mode re-tightened to 0600 if loosened | No error expected |
| invalid key file | key file not valid key material / oversized / symlink | startup refuses; diagnosable error | no auto-regeneration, no overwrite |
| Node below floor | entrypoint starts with Node 24.14.x or 23.x | process exits non-zero; stderr names the Node version gate and found version | diagnosable error |
| Node at floor | Node 24.15.0 exactly | gate passes | No error expected |
| SQLite below floor | bundled SQLite 3.51.2 | process exits non-zero; stderr names the SQLite gate and found version | diagnosable error |
| dependency audit | `package.json` / source tree | no non-empty `dependencies`/`devDependencies`; no `node_modules` directory in source root or packaged output; no bare (non-`node:`, non-relative) imports under `server/` | static test fails otherwise |

</intent-contract>

## Code Map

- `server/runtime.mjs` -- extends here: `assertSupportedRuntime` (line 47) checks major-only Node — tighten to compareVersions ≥ '24.15'; `MIN_NODE_MAJOR` (line 20) superseded by a version-floor constant; `ensurePrivateDirectory`/`regularPrivateFile`/`readJsonFile`/`atomicWriteJson` (lines 67–147) are the ratified 0700/0600/non-symlink/size-bound machinery to reuse for key files; `loadOrCreateIdentity` (line 154) stays untouched — the keypair lives beside `identity.json`; `MAX_FRAME_BYTES` (line 22) moves to constants (re-export or update importers).
- `server/keys.mjs` -- NEW: `loadOrCreateKeypair(pluginDataDir)` + `fingerprintFromPublicKey(raw32)`; uses `node:crypto` `generateKeyPairSync('ed25519')`; raw 32-byte public key = last 32 bytes of SPKI DER; file `identity.key` beside `identity.json`.
- `server/constants.mjs` -- NEW: every AD-9 limit + PUBLIC_ERRORS→HTTP-status table + send-status enum + protocol header name/value; the only file in the repo allowed to state these numbers.
- `server/mcp-stdio.mjs` -- entrypoint; local `MAX_TOOL_TEXT` (line 22) and runtime's `MAX_FRAME_BYTES` import switch to constants; the `launchedDirectly` try/catch (lines 321–328) is the exit-non-zero-on-gate-failure pattern to preserve.
- `server/roomd.mjs` -- `PUBLIC_ERRORS` (line 35), `MAX_WAIT_MS` (line 17), SSE backlog bounds (lines 18–19) move to constants and import back; entrypoint gate at line 143 already exits non-zero — verify message names the gate.
- `server/database.mjs` -- `DATABASE_LIMITS` (line 18) re-points to constants; SQLite gate (line 119) already injectable — keep.
- `server/daemon-client.mjs` -- untouched this story (imports `MAX_FRAME_BYTES` — update import source only if runtime stops exporting it).
- `package.json` -- zero deps already; `engines.node` ">=24" → ">=24.15".
- `tests/runtime.test.mjs` -- existing gate/permission tests; extend for the 24.15 floor and entrypoint-exit behavior.
- `tests/constants.test.mjs`, `tests/keys.test.mjs`, `tests/zero-deps.test.mjs` -- NEW.

## Tasks & Acceptance

**Execution:**
- `server/constants.mjs` -- create with all AD-9 limits (message 32,768 chars · frame 1 MiB · page 200 · hold 20,000 ms · heartbeat 60 s ±10% / TTL 180 s · SSE keep-alive 30 s + backlog bounds · duplicate window 5 s · storage 1 GiB/256 MiB · backoff 1–60 s · held 100 · offline 24 h · viewer 5 s · send bucket 0.5/s cap 10 · request budget 120/min burst 30 · enrollment 5/min burst 5 · invite 1 use/24 h · session TTL 12 h) plus identifier bounds (client_message_id 128, display name 80, title 120, chat_id 32) and the PUBLIC_ERRORS→HTTP-status table seeded with v0.1's 16 codes -- the AC's "imported by name, never restated" foundation.
- `server/keys.mjs` -- create keypair load/create + canonical fingerprint; refuse invalid/oversized/symlinked key files without overwriting -- keypair born in 1.1 for all Epic 1 consumers.
- `server/runtime.mjs` -- tighten `assertSupportedRuntime` to Node ≥ 24.15 (compareVersions, injectable versions kept for tests) and move its frame limit to constants -- AC rows "Node below floor"/"at floor"/"SQLite below floor".
- `server/mcp-stdio.mjs` + `server/roomd.mjs` + `server/database.mjs` -- re-point duplicated limits/error tables to constants; confirm each entrypoint exits non-zero naming the failed gate -- dedupe without behavior change.
- `package.json` -- engines.node → ">=24.15" -- gate reflected in manifest.
- `tests/constants.test.mjs` / `tests/keys.test.mjs` / `tests/zero-deps.test.mjs` / `tests/runtime.test.mjs` -- cover every matrix row; entrypoint-exit tests spawn real children that mutate `process.versions` (or defineProperty) then import the entrypoint; zero-deps test asserts empty deps, no node_modules in source root, no bare imports under `server/` -- matrix coverage.

**Acceptance Criteria:**
- Given Node < 24.15 or SQLite < 3.51.3, when any entrypoint starts, then it exits non-zero with a diagnosable error naming the failed gate.
- Given a fresh PLUGIN_DATA, when keys initialize, then one Ed25519 keypair (0600) exists and the fingerprint is `sha256:` + lowercase hex SHA-256 over the raw 32-byte public key, stable across reloads.
- Given shared data dir and PLUGIN_DATA, when created or used, then dirs 0700, files 0600, regular non-symlink, size-bounded; the static zero-dependency check passes.
- Given any enforcement point, when it needs a bound or an error's HTTP status, then it imports from `server/constants.mjs`; a static check finds no restated limit literals outside it.

## Spec Change Log

## Review Triage Log

### 2026-09-25 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 21: (high 4, medium 9, low 8)
- defer: 3: (low 3)
- reject: 12
- addressed_findings:
  - `high` `patch` keys.mjs non-atomic key publish (crash mid-write could permanently brick startup under the never-regenerate policy) — replaced with temp-file write + partial-write loop + fsync + exclusive `linkSync` publish (rename would clobber a concurrently published key; deviation from the suggested renameSync, flagged and accepted), temp unlinked on every failure path
  - `medium` `patch` keys.mjs TOCTOU symlink swap between lstat and read — O_NOFOLLOW open + fstat re-verification + exact-size read loop + fchmodSync
  - `medium` `patch` fingerprintFromPublicKey accepted strings/numbers/objects (uncoded TypeError) — now accepts only Buffer/Uint8Array of exactly 32 bytes, coded identity_key_invalid; SPKI DER length asserted before subarray(-32)
  - `high` `patch` ENOSPC/EACCES during first key write left a partial file with no recovery — temp unlink on failure covers it
  - `high` `patch` concurrent creators could read a partial key file (EEXIST race) — exclusive link publish; new real-child-process race test (two children, same fingerprint, one file, no leftovers)
  - `medium` `patch` PUBLIC_ERRORS table missed wire-visible v0.1 codes — added message_frame_too_large/request_too_large/request_cancelled (400), daemon_start_busy (503), daemon_start_failed/daemon_start_lock_invalid/node_version_unsupported/identity_key_invalid (500); key sets of the two tables asserted equal
  - `medium` `patch` viewer route restated the page bound as literal 200 at roomd.mjs — re-pointed to READ_PAGE_MAX plus a limit=READ_PAGE_MAX+1 viewer test proving the clamp tracks the constant
  - `medium` `patch` keys.mjs restated 4096 outside constants — moved as KEYPAIR_FILE_MAX_BYTES
  - `medium` `patch` owned bounds restated in regex/clamp form ({0,127} quantifiers, slice(0, 80)) — now derived from IDENTIFIER_MAX/DISPLAY_NAME_MAX
  - `medium` `patch` direct-launch gate failure died as uncaught import-time exception with stack trace — entrypoints now print one diagnosable line naming gate + found version and exit 1; importers still get a catchable rejection
  - `low` `patch` gate messages could render "found " for empty-string versions — `|| 'unknown'` with regression tests
  - `low` `patch` package.json engines and MIN_NODE_VERSION could drift — new agreement test
  - `low` `patch` zero-deps/import scans skipped scripts/ and could crash on dangling symlinks — scripts/ added, walkers symlink-safe, packaged artifact asserted node_modules-free
  - `low` `patch` README Node requirement stale — updated to 24.15

## Design Notes

Raw key extraction: `publicKey.export({ type: 'spki', format: 'der' })` → take `.subarray(-32)` for Ed25519. Fingerprint: `sha256:${createHash('sha256').update(raw32).digest('hex')}` (hex lowercase). Entrypoint gate test seam: `process.versions` fields are plain properties — assign or `Object.defineProperty` in a spawned `node --eval` child, then dynamic-import the entrypoint; assert non-zero exit and stderr content. Error→HTTP mapping for the seeded table: invalid_* 400 · not_found 404 · forbidden/not-member 403 · conflict 409 · runtime/data-dir 500 — later stories add codes additively, never restate statuses per-route.

## Verification

**Commands:**
- `node --test` -- expected: all tests pass, including the new constants/keys/zero-deps suites and extended runtime suite.
- `node -e "process.versions.node='24.14.9'; await import('./server/mcp-stdio.mjs')"` (as a spawned child in a test) -- expected: exit code ≠ 0, stderr mentions the Node gate.
- `grep -rnE "32 \* 1024|1024 \* 1024|20_000" server/ --include='*.mjs' | grep -v constants.mjs` -- expected: no matches (limits stated once).
- `ls node_modules 2>/dev/null; node -e "const p=require('./package.json'); console.log(Object.keys(p.dependencies??{}).length + Object.keys(p.devDependencies??{}).length)"` -- expected: no node_modules; count 0.

## Auto Run Result

Status: done

**Summary:** Story 1.1 (Runtime foundation & single limits module) implemented on top of v0.1: one constants module now owns every AD-9 limit, identifier bound, wire-visible error code (24) and its HTTP status, the send-status enum and protocol header; startup gates tightened to the ratified Node ≥ 24.15 / SQLite ≥ 3.51.3 floors with one-line diagnosable entrypoint failures; one Ed25519 keypair per installation with the canonical `sha256:`-prefixed fingerprint (atomic publish, O_NOFOLLOW reads, never regenerates over invalid material); zero-external-dependency checks extended to scripts/ and packaged artifacts; v0.1 modules re-pointed to the constants module with no behavior change beyond the tightened gate.

**Files changed:**
- `server/constants.mjs` (new) -- single limits + error/status tables; the only file allowed to state these numbers
- `server/keys.mjs` (new) -- `loadOrCreateKeypair` + `fingerprintFromPublicKey` (raw 32-byte SHA-256, `sha256:` hex)
- `server/runtime.mjs` -- Node ≥ 24.15 gate naming gate + found version; permission machinery exported; constants re-point
- `server/mcp-stdio.mjs` -- constants re-point; one-line gate failure, exit 1, no stack trace
- `server/roomd.mjs` -- constants re-point; viewer clamp → READ_PAGE_MAX; top-level gate
- `server/database.mjs` -- DATABASE_LIMITS + identifier regex derived from constants
- `package.json` / `README.md` -- engines ≥ 24.15 (tested against MIN_NODE_VERSION); README floor text
- `tests/constants.test.mjs`, `tests/keys.test.mjs`, `tests/zero-deps.test.mjs` (new); `runtime/package/daemon/daemon-client/mcp` suites extended

**Review findings breakdown:** 4 review layers (Blind Hunter, Edge Case Hunter, Verification Gap, Intent Alignment). Patched 21 (high 4, medium 9, low 8) — all applied and re-verified; deferred 3 (AGENTS.md stale floor text — template-managed; SSE 30 s vs live 15 s — reconcile in Story 1.3; ensureDaemon swallows gate stderr — surface in Stories 1.3/1.4); rejected 12 (design-sanctioned: unwired keys module by Reading A, dead constants awaiting consumers, v0.1 shim aliases, scanner false-positive breadth, host-coupled floor tests, status-mapping choices without consumers).

**Follow-up review recommendation:** true — patched counts high 4 / medium 9 / low 8, score 3×9 + 8 = 35 ≥ 5 (high present regardless).

**Verification performed:** `node --test` → 55 pass / 0 fail / 0 skipped (includes real packager run, two live MCP clients + daemon, and a two-child keypair race test); spawned-child gate test with Node 24.14.9 → exit 1, one-line message naming the Node gate; literal scan outside constants.mjs → clean; no node_modules, dependency count 0. Matrix Test Audit: all 7 I/O matrix rows covered by named passing tests (fresh keypair, reload, invalid/oversized/symlinked key file, Node below/at floor, SQLite below floor, dependency audit).

**Residual risks:** `PUBLIC_ERROR_STATUS` is seeded but unconsumed until Story 1.3 routes land (viewer routes keep v0.1 statuses meanwhile); `keys.mjs` is born but unwired — Epic 1 consumers (pair keys, claims, presence, envelope) adopt the fingerprint from Stories 1.2–1.7 onward; SSE cadence and daemon gate-stderr deferrals above; `sprint-status.yaml` still lists 1-1 as backlog (owned by bmad-sprint-planning — rerun that skill to refresh).

### 2026-09-25 — codex-advisor[gpt-6-luna] audit of the foundation (the one story that shipped before the auditor was in the loop)
Verdict FIX-FIRST, no high findings. All accepted and applied in `bd91f98` + the follow-up commit.

- intent_gap: 0
- bad_spec: 0
- patch: 4: (medium 2, low 2)
- defer: 1: (low 1)
- reject: 0
- addressed_findings:
  - `medium` `patch` `openSync(path, O_RDONLY | (O_NOFOLLOW ?? 0))` silently opened the symlink the check exists to refuse on any platform lacking the flag — O_NOFOLLOW is now REQUIRED and a platform that cannot enforce it refuses to read an identity key file rather than reading one it cannot verify
  - `medium` `patch` the static guards missed real restatements — `runtime.mjs`'s `64 * 1024` state-file default is now the named `STATE_FILE_MAX_BYTES`, and the setup CLI's `CONFLICT_STATUS` is derived from `PUBLIC_ERROR_STATUS.chat_id_taken` instead of a literal 409
  - `low` `patch` the direct-launch half of the gate contract (one diagnosable line, exit 1, no stack trace) was untested — now proven per entrypoint by spawning a real launch
  - `low` `patch` FR-3 claimed proof of possession for every connection while the ratified Local Mode path only presents the key — PRD carries a dated amendment stating that possession proof is the remote path's guarantee (Epic 4) and that Local Mode's claim is the OS-user boundary
- notes: the auditor also confirmed the setup CLI shipped ungated, which this pass fixed (Story 1.7c added an entrypoint that Story 1.1's "every entrypoint" AC had to cover) — the entrypoint list in tests/runtime.test.mjs is now the regression guard. Deferred: the SSE keep-alive divergence in the retired v0.1 `roomd.mjs` (already recorded in 1.1; nothing spawns that daemon). Not fixed by choice: the literal-import scanner's blind spot for computed specifiers, since a computed bare specifier is a code smell the runtime already rejects (zero-dep) and broadening the scanner was rejected in 1.1's own triage.
