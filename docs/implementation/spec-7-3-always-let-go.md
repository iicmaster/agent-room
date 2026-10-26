---
title: 'Always let go — the bounded shutdown operation (A8 signal-safe teardown, A9 bind-after-shutdown)'
type: 'feature'
created: '2026-10-26'
status: 'review'
baseline_revision: 'working-tree on f421027 (Story 7.1 closed; this story touches server/mcp-stdio.mjs and server/client/api-client.mjs)'
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/epics.md (Story 7.3)'
  - '{project-root}/server/mcp-stdio.mjs (the input.once(close) release, no signal handlers)'
  - '{project-root}/server/client/api-client.mjs (release(), authenticate()/bindWithToken(), ensure())'
  - '{project-root}/server/constants.mjs (CLIENT_RELEASE_TIMEOUT_MS = 2000 — the declared deadline)'
  - '{project-root}/tests/session-replacement.test.mjs (the real-child stdin-close row and its harness)'
problem: |
  Two recorded races (Epic 6 retro A8, A9):

  - **A8** — the adapter's only shutdown trigger is `input.once('close')`, and
    its release is fire-and-forget (`void releaseSession()`). A host that
    SIGTERM/SIGINTs the MCP child (what a one-shot vendor CLI does on exit)
    kills a process that never listened for signals, and the orderly-exit
    release loses the race against the kill — the REL-1 run saw `ZCODE-MAC-2`
    stay reserved after three clean `zcode -p` exits.
  - **A9** — stdin can close while the FIRST authentication/bind is still
    pending. `release()` reads the client's `sessionToken`, which is still
    `null` (no_session), and returns; the in-flight `authenticate()` then
    completes `bindWithToken()` AFTER the shutdown release already ran — the
    dying process binds the name it just failed to release.
approach: |
  **One shared, bounded shutdown operation in the adapter.** `shutdown()` is
  single-flight (every trigger joins the first): it aborts every in-flight
  call (admission stops), then awaits the client's release — bounded by the
  declared `CLIENT_RELEASE_TIMEOUT_MS` inside the client — and records the
  outcome (`released` / `no_session` / `release_failed`). SIGTERM and SIGINT
  run `shutdown()` and exit when it settles (the bound keeps the exit inside
  the declared deadline); stdin `close` joins the same operation; the
  returned `close()` becomes awaitable and joins it too. The process is never
  held open past the bound: the release timer is the deadline.

  **The client owns the late-bind guard (A9).** `release()` marks the client
  `shuttingDown` BEFORE reading the token, so no later bind can publish a
  token. An `authenticate()` that starts after shutdown began refuses with a
  coded `shutdown` error (no new session is ever created by a dying client).
  A bind already in flight when shutdown began completes its HTTP bind and
  then ROLLS BACK: it deletes the just-bound session (best-effort, bounded),
  never assigns the token, and refuses with the same coded error. `ensure()`
  joins the refusal naturally through `authenticate()`.

  **Honest boundary (unchanged, stated in docs):** SIGKILL, OOM kills, power
  loss, and a dead remote peer are outside any teardown path's reach — those
  are Story 7.4's subject. The existing 2,000 ms release timeout remains the
  declared deadline (a socket idle timeout implements it; the deadline is the
  constant, not a separate unproven total).
acceptance_criteria: |
  | # | Given | When | Then |
  |---|---|---|---|
  | 1 | A live MCP child holding its name | SIGTERM | the release completes and the name is free before (or as) the process exits; a stranger binds it at once |
  | 2 | The same child | SIGINT | the same (repeated signals and stdin close join one operation — no double release, no error) |
  | 3 | stdin closing while the FIRST auth/bind is in flight | the shutdown release runs first | the late bind never publishes: the name is free after everything settles (the A9 race, pinned by a deterministic client-level test) |
  | 4 | A tool call arriving after shutdown began | the client is asked for anything | a coded `shutdown` refusal — no new session, no new bind |
  | 5 | The release target unreachable | shutdown | the outcome is recorded (`release_failed`), the process exits under the declared 2,000 ms bound |
  | 6 | The shipped prose | read | README/CHANGELOG carry the repair per A1; the "one-shot CLI leaves its name reserved" caveat now names the SIGTERM/SIGINT path as covered |
files: |
  - `server/client/api-client.mjs` — the `shuttingDown` guard in release/authenticate/bindWithToken; the coded shutdown refusal.
  - `server/mcp-stdio.mjs` — the shared single-flight `shutdown()`; SIGTERM/SIGINT wiring; the awaitable `close()`.
  - `tests/session-replacement.test.mjs` — real-child SIGTERM and SIGINT rows; the deterministic A9 client-level row; the repeated-signal join row.
schedule: |
  1. Implement client guard + adapter operation. 2. Tests. 3. Full suite
  (serial, 600 s). 4. Codex review round. 5. A1 doc sweep in the same commit.
notes: |
  - `PUBLIC_ERROR_STATUS` needs the new `shutdown` code's status (400) in the
    constants module (AD-9: one table, never per-route).
  - The stdin-close row already green must stay green (the release still runs
    on stdin close; only the bookkeeping changed).
