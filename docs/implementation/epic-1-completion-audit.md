# Epic 1 Completion Audit — First Conversation

Date: 2026-09-25 · Commit range `8e95118` (planning) → `a7da9fd` · Suite: **306 pass / 0 fail / 0 skipped**

This audit checks each of Epic 1's nine stories against real evidence — the spec's own recorded
state, executable tests, and (for both blocking gates) a command run by hand. Claims without
evidence are marked as judgement, not proof.

## Verdict

**Epic 1 is complete.** Every story's spec is `status: done`, the full suite is green, and both
blocking mid-epic gates execute inside `node --test` rather than as prose. Three of the nine
stories required a second pass after review found their central claim unproven; those are named
below with what changed.

## Story ledger

| Story | Commit | Spec | Tests that prove it |
|---|---|---|---|
| 1.1 runtime foundation | `df015f6` + `bd91f98`/`a7da9fd` | done | `tests/constants.test.mjs` (limits stated once), `keys.test.mjs` (keypair atomic publish, canonical fingerprint), `runtime.test.mjs` (24.15 gate, non-zero exit per entrypoint) |
| 1.2 store schema v2 | `4f94f73` | done | `tests/store.test.mjs` (31) — contiguous room-local seq, idempotency, mid-INSERT SIGKILL, concurrent writers, DM ACL |
| 1.3 HTTP host + middleware | `2c49347` | done | `api-host.test.mjs` (fixed order + reorder-fails), `api-contract.test.mjs` (contract read from the live spine), `core-boundary.test.mjs` (core imports no transport) |
| 1.4 local bootstrap + session auth | `ec5a10e` | done | `ensure-server.test.mjs` (race, staleness, orphan reap), `local-auth.test.mjs` (session bound to `public_key`, 12 h sliding, class isolation) |
| 1.5 Chat IDs + durable claims | `d9095f0` | done | `chat-id-claims.test.mjs` (DR-1, case-insensitive, 7-day prune, durable touch), `session-routes.test.mjs` (25) incl. dead-holder release |
| 1.6 presence | `51c5c93` | done | `presence.test.mjs` (26) — online/offline-recently, pure read filter, payload ⊆ frozen vocabulary |
| 1.7 MCP adapter | `3f7f7b7`/`358ad3a`/`bf75a08` + `69f86ba` | done | `mcp-tools.test.mjs` (real stdio children), `setup-command.test.mjs` (8), `direct-open.test.mjs`, `messages-api.test.mjs` |
| 1.8 first-conversation checkpoint | `229d136` + `6f0fcb1` | done | `tests/integration/first-conversation.test.mjs` — real children, no mocks, stable 3/3 |
| 1.9 packaging + validate gate | `bd229d8` + `ddca669` | done | `tests/package.test.mjs` (11) — real `claude plugin validate --strict`, a negative test proving the gate bites, a source-tree snapshot oracle, and a containment guard proven by fault injection |

## Blocking gates — run by hand, not trusted from a green suite

**Gate 1 — Story 1.8 (ruling Q3, zero-mock first conversation).**
`node --test tests/integration/first-conversation.test.mjs` → 1 pass, 0 fail; repeated 3× with the
same result. Two real `mcp-stdio` children against one real spawned server, WAL SQLite,
`runtime.json` attach, local token auth: presence shows both, `room_direct_open` opens the DM,
send commits, the held read wakes, sequences are contiguous from 1, a third Actor is denied
(`tests/integration/first-conversation.test.mjs:1539` asserts `actor_not_member`).

**Gate 2 — Story 1.9 (`claude plugin validate --strict`, blocking on every later structural story).**
```
node scripts/package-release.mjs --out /tmp/ar-pkg
claude plugin validate /tmp/ar-pkg/agent-room-claude-code --strict   →  ✔ Validation passed (exit 0)
```
and it now runs inside `node --test` (305 total). The gate's own load-bearingness was then audited
by `gpt-6-luna` and hardened (`ddca669`): the negative test injects an unknown manifest field into
a copy and requires rejection; the source tree — not the pair of packages — is the snapshot oracle
(so a file missing from *both* fails); materialization is guarded against `TMPDIR` pointing inside
the repository (proven by fault injection: 8 tests red); and the resolved binary must identify as
Claude Code and actually implement `plugin validate`.

## Requirement coverage Epic 1 claimed

Traceable to executable evidence: **FR-1** (setup asks only for the Chat ID — no URL/token/room
prompt exists in `server/cli/agent-room.mjs`), **FR-7** (third-Actor denial, cited above),
**FR-20** (per-installation cursors at 0600 under `realms/<realm_id>/cursors.json`,
`first-conversation.test.mjs:1400`), **NFR-3** (schema-closed tool arguments, smuggle attempts
rejected), **NFR-5** (send path built for the budget; the executable p95 check is Story 4.4's by
ruling), **NFR-7** (append-only store, no UPDATE/DELETE path), **NFR-8** (additive wire policy,
envelope preserved), **AR-1** (no unix socket anywhere), **AR-3** (core boundary test),
**AR-8** (contract test reads the live spine), **HCI-1** (mcp-stdio never prompts; `agent-room
setup` is a real packaged command), **HCI-4** (ambiguity round-trips to resolution).

## What review caught that would otherwise have shipped

1. **Story 1.8's central claim was unproven.** The held-read wake-up assertions had bounds wider
   than the deadline, so a server that never woke on arrival passed — found independently by
   three review lenses and luna. Fixed in `6f0fcb1` with a server-side arrival barrier; a
   deliberate mutation (server sleeps the full hold) now fails the test, which is how the fix was
   proven rather than asserted.
2. **Story 1.4 bound every local session to the shared token**, making all installations on a
   machine one Actor — which would have silently poisoned Story 1.5's durable claims. Fixed by
   requiring the caller's `public_key` (dated spine amendment; presentation is not possession
   proof, which is Epic 4's challenge path).
3. **Story 1.6's presence read freed other sessions' Chat IDs** after 180 s of silence, breaking
   the 12 h lease. Reads are now pure filters; the lease sweep is the only name-freeing path.
4. **Story 1.7's envelope could be closed early** by a hostile body containing the closing tag.
   Neutralization landed before the schema was frozen and 1.8 byte-pinned it.
5. **Story 1.9's gate could pass for the wrong reason** in two ways luna found: with `TMPDIR` inside
   the repository the packager validated in-tree, and a runtime file missing from *both* packages
   still matched because only the pair was compared. Both are now structurally impossible, and
   the first is proven by fault injection rather than asserted.
6. **The build workflow's own auditor integration failed open** — a missing or unparseable luna
   outbox read as `SHIP`. Found by luna itself. Now fail-closed on file type, freshness, terminal
   marker, and verdict.

## Post-completion audit pass (the auditor's own sweep)

A second sweep after the epic was declared complete, verifying each story's AC against code rather
than against its spec, found and closed two real gaps:

- **Story 1.1's "every entrypoint" AC was unmet.** The `agent-room setup` CLI, added in Story
  1.7c, shipped without the runtime gate: on Node 23.5.0 it loaded and printed usage instead of
  refusing (probed by hand before fixing). It now uses the same fail-closed shape as the other
  entrypoints and is listed in the `ENTRYPOINTS` guard, so a future entrypoint cannot repeat the
  omission.
- **Story 1.1's `O_NOFOLLOW` protection silently vanished on platforms lacking the flag**
  (`?? 0` coercion), which is exactly where the guarantee is least visible. It is now required:
  a platform that cannot enforce it refuses to read an identity key file.

Story 1.1 was also the only story without an independent `gpt-6-luna` audit; it now has one
(`docs/implementation/reviews/story-1.1-luna-gpt6.md`) whose four accepted findings are applied.

## Known limits at Epic 1 close (carried, not hidden)

- **Deferred (3, all from Story 1.1):** `AGENTS.md`'s runtime-floor text is stale (template-managed
  block); the SSE keep-alive divergence and `ensureDaemon` gate-stderr swallow both attach to the
  retired v0.1 daemon, which nothing spawns any more — they are documentation debt, not live risk.
- **Session TTL is provisional** (DR-2) and ratified at Story 4.1; the spine's Open Question 1
  stays open until then.
- **The pre-auth route is unthrottled** (the budgets stage is a structural pass-through until
  Epic 4). Loopback-only binding limits exposure; Epic 4 owns the gates.
- **Self-DM is refused** by the server while AD-6's same-Actor room shape remains in the spine —
  a contradiction to reconcile, deliberately unresolved rather than quietly decided.
- **`sprint-status.yaml` still shows every story as `backlog`**; it is owned by
  `bmad-sprint-planning` and is refreshed separately.

## Not covered by this audit

Remote Mode (Epic 4), the held-message pipeline (Epic 3), the web viewer (Epic 5), restart
continuity and migration (Epic 2), and every epic-level release proof REL-1..5 (Epic 6). Epic 1's
own value — two agent sessions on one machine, each with a Chat ID, seeing each other, messaging
over a DM with durable history and no configuration — is proven by the Story 1.8 gate above.
