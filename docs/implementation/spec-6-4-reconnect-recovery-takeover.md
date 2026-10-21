---
title: 'Reconnect recovery — the explicit session takeover'
type: 'feature'
created: '2026-10-20'
status: 'in-progress'
baseline_revision: '89c847787357be9e0ede135337eee4a1a29f48bf'
context:
  - 'project context: Node >=24.15, native ESM, node:sqlite STRICT WAL with synchronous=FULL, zero external runtime dependencies, and real-child node:test gates'
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/implementation/reviews/epic-6-lease-astra.md'
  - '{project-root}/docs/implementation/spec-2-2-reconnection-room-discovery.md'
warnings: []
deferred:
  - 'Automatic (unattended) crash recovery — the successor process cannot be identified from the Actor key alone; it needs a session-resume/ownership design, which this story deliberately does not build.'
---

<intent-contract>

## Intent

**Problem:** FR-12 asks that a client which died, slept, or lost connectivity can reclaim or re-pick its Chat ID. The shipped server could do neither. A live session row holds its Chat ID for the lease (12 h); the row outlives the process that created it, because the server never learns that the process is gone. Presence filters a silent row out of the online group after 180 s, so the operator sees the holder as OFFLINE while the name is still taken. The ordinary re-auth recovery (`server/api/server.mjs`) releases a dead holder only when that holder's session TOKEN no longer authenticates — and the token's 12 h sliding TTL is refreshed by the very act of verifying it, so a client that was killed with its token intact leaves a row that is both offline in presence and live in authentication. The restart is then permanently unrecoverable under its own name: `chat_id_taken`, forever or until the lease. The physical REL-1 run hit exactly this on the Zcode host (the Chat ID's name is the only thing that was broken; the room, the history, the peer and the trust matrix all worked).

**Approach:** an EXPLICIT, operator-authorized, same-Actor handoff — and nothing else. The client never takes a name by itself; a reconnect never decides anything; the takeover is a human decision the operator takes with one command. The mechanism has four parts, each answering one advisor guarantee:

1. **The intent (wire).** `POST /api/session` accepts one additive boolean field, `replace_existing`. Absent means false. `PATCH /api/session` does NOT accept it: a rename never takes a name. The intent is a request-shape field, never an identity field — the Actor still comes from the session token alone.
2. **The grant (server).** The server grants the takeover only when the live holder is the SAME Actor. The live registry re-checks the incumbent against its own rows (the named session must still hold the name AND belong to the caller's Actor), so the api layer's word about who it is displacing is never taken on trust. A foreign Actor's session is never displaced, and the refusal is the ordinary `chat_id_taken` — the refused caller learns nothing about the holder.
3. **The transfer (atomicity).** The durable `chat_id_claims` write happens BEFORE the memory commit; a failed write leaves the incumbent exactly where it was. The memory commit itself is synchronous (no await between the two halves), so no observer can see the name held by neither session or by both. The durable claim row is untouched by the transfer — it is the same Actor's row, and it stays as the (name, actor) ambiguity data it always was.
4. **The fence (authority ends with the handoff).** The displaced session's token stops authenticating, and its session key is fenced: the pipeline's authorization stage re-checks the fence immediately before the handler runs, so a request admitted BEFORE the handoff cannot land AFTER it. Without the fence a displaced client could take the name back by re-authenticating, and the takeover would be a ping-pong rather than a handoff.

Around the mechanism, two surfaces make it usable rather than merely possible: the MCP adapter releases its session on an orderly exit (so the common case — a client that ended normally — never squats a name at all), and the operator command `agent-room session replace` performs the takeover deliberately, asks for an interactive confirmation, and reports honestly what it did.

## Boundaries & Constraints

**Always:** authenticate the Actor from server-derived credentials and never from a request field; grant the takeover only to the SAME Actor, re-checked by the registry against its own rows; write the durable claim before the memory commit and leave the incumbent untouched when the write fails; commit the memory transfer synchronously; end the displaced session's authority WITH the handoff (revoke the token, fence the key, re-check the fence at the authorization stage); keep `DELETE /api/session` session-key-scoped so a delayed predecessor disconnect cannot release the successor; keep the ordinary startup bind, the `PATCH` rename, and every automatic re-authentication free of the takeover intent; refuse a foreign-Actor takeover with the ordinary collision code; preserve the same Actor's other Chat IDs, the peer's session, room membership, history, and cursors.

**Block If:** a takeover displaces a session of a DIFFERENT Actor — halt; trust binds fingerprints, never names. A takeover happens without an explicit intent — halt; a reconnect must never decide who owns a name. The durable write fails and the incumbent is disturbed — halt; persistence failure must leave the incumbent intact. The displaced session can still act, or can take the name back by re-authenticating — halt; the handoff must be final. A late request from the displaced session lands after the handoff — halt; admission alone is never authority. The takeover changes any room, message, cursor, or peer state — halt; only the name moves.

**Never:** do not shorten the lease or treat presence silence as death — a client may legitimately be idle for hours (agent-generation gaps are permitted), and a timeout is an ownership policy, not proof of death; do not add a remote PID check — the protocol cannot distinguish sleep from partition from death; do not add persistent resume storage or a resume token — the automatic-successor problem is a separate design, explicitly deferred; do not let the MCP client carry the takeover intent — only the operator command does; do not let the takeover reach the `PATCH` rename verb; do not add a second entrypoint — the command joins the existing CLI host; do not expose the incumbent's bearer or token digest as a takeover credential; do not mint or flood tokens as a recovery path.

## I/O & Edge-Case Matrix

| # | Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|----------|--------------|---------------------------|----------------|
| 1 | The squat | the holder's process is gone; its row lives; its token still authenticates | a plain re-bind is refused `chat_id_taken` (409); nothing changes; the message names the recovery command | the server cannot tell a dead process from a quiet one — it refuses rather than guesses |
| 2 | The takeover | the operator's command, holder = same Actor | 200; `chat_id: 'Agent'`; `replaced: true`; the name moves; the holder is fenced | the grant is the same-Actor check plus the registry's own re-check |
| 3 | A foreign holder | a DIFFERENT Actor's session holds the name | 409 `chat_id_taken`; the refusal names no holder; the holder keeps working | identical wording for every refusal — no leak about who holds the name |
| 4 | A malformed intent | `replace_existing` present but not a boolean | 400 `invalid_request` naming the field; no state change | the intent is never truthy-guessed |
| 5 | The intent on the wrong verb | `PATCH /api/session` with `replace_existing` | `unknown_field` — the rename verb does not accept it | a rename never takes a name |
| 6 | Persistence failure | the durable claim write throws during the transfer | the transfer throws; the incumbent still holds the name; its session still works | the memory side is untouched until the write succeeded |
| 7 | The displaced session's late requests | its old token used for a bind, a rename, a send, a disconnect | all 401 `unauthorized`; the successor still holds the name | the token is revoked at the handoff and the key is fenced |
| 8 | A request admitted before the handoff | a request that authenticated before the takeover and runs after it | refused at the authorization stage | the fence is re-checked immediately before the handler |
| 9 | Ownership ping-pong | the displaced client re-authenticates and binds plainly | refused `chat_id_taken`; the name does not flip back | the automatic path never carries the intent |
| 10 | Competing takeovers | two same-Actor sessions both ask | the last explicit intent wins; the earlier one is fenced | deterministic: an explicit handoff is a decision, and the newest one is it |
| 11 | The Actor's other names | the same Actor holds a second Chat ID | untouched; its session still works | only the named name moves |
| 12 | Rooms, history, cursors, peers | a DM opened and used before the takeover | the room, its history, the cursor and the peer's session are unchanged; the successor reads and writes the same room | the takeover is a name operation, not a data operation |
| 13 | The orderly exit | the MCP adapter's stdin closes | it releases its session; the name is claimable again at once | the release is best-effort and bounded; it never bootstraps a session to close one |
| 14 | The operator command, non-interactive | `agent-room session replace` with a piped stdin | refused (exit 1) with the TTY guidance; nothing changed | a command that needs a human answer can never be driven programmatically into one |
| 15 | The operator command, declined | the operator answers "n" | refused (exit 1); nothing changed | the decline is reported, never silent |
| 16 | The operator command, accepted | the operator answers "y" | one JSON receipt on stdout: the Chat ID, the mode, the fingerprint, `replaced`, `released`, and the note that the name is free until the live client binds it again | the prompt goes to stderr, so stdout stays JSON-lines only |

## Code Map

- `docs/epics.md` — Story 6.4, the acceptance criteria above.
- `docs/implementation/reviews/epic-6-lease-astra.md` — the advisor round-table that scoped this repair (same-Actor handoff with atomic transfer and fencing).
- `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md` — the dated 2026-10-20 AD-8 amendment: `replace_existing` joins the request vocabulary, `replaced` joins the response vocabulary.
- `server/core/session-registry.mjs` — **extended.** `claim` is split into a shared `commit` plus the unchanged `claim` surface; `transfer` is the explicit takeover, re-checking the incumbent's identity against the registry's own rows and committing the memory side synchronously after the durable write.
- `server/api/session.mjs` — **extended.** `supersede(sessionKey)` (revoke + fence) and `isSuperseded(sessionKey)`; the fence set is bounded like the session map.
- `server/api/server.mjs` — **extended.** `bindSession` reads the strict-boolean intent, grants it only to the same Actor, calls `transfer` when an incumbent exists, fences the displaced session, and answers `replaced`.
- `server/api/pipeline.mjs` — **extended.** The `authz` stage re-checks the fence immediately before the handler (admission alone is never authority).
- `server/client/api-client.mjs` — **extended.** The bind never carries the intent; a `chat_id_taken` collision now names the recovery command; `release()` hands the name back on an orderly exit (and never bootstraps a session to close one).
- `server/mcp-stdio.mjs` — **extended.** The adapter releases its session when stdin closes.
- `server/cli/session-commands.mjs` — **added.** `agent-room session replace`: authenticate as this installation, ask for the takeover, release the name again, print one JSON receipt.
- `server/cli/http.mjs` — **extended.** `cliHttpJsonUrl` — the same bounded round trip against a URL target (https with Node's default verification), so the remote lane shares one substrate with the loopback helper.
- `server/constants.mjs` — **extended.** `CLIENT_RELEASE_TIMEOUT_MS` — the orderly-exit release bound.
- `tests/session-replacement.test.mjs` — **added.** The acceptance rows.

</intent-contract>

## Testing Strategy

Eleven rows, all against real servers and real keypairs — no wire mocks. The defect row reproduces the squat (a live row holding the name while its token still authenticates) and proves the plain re-bind is refused and the takeover recovers it. The grant rows prove the same-Actor grant, the foreign-Actor refusal (including that the refusal leaks no holder identity), the malformed intent, and the intent on the wrong verb. The fence rows prove the displaced session's late bind/rename/send/disconnect are all refused and that its late disconnect cannot release the successor. The stability rows prove no ownership ping-pong, the deterministic outcome of two competing takeovers, a failed durable write leaving the incumbent intact, and the Actor's other names / rooms / history / cursors / peer surviving the takeover unchanged. The surfaces: the real MCP child hands its name back when its stdin closes (a real child process, a real exit), and the operator command refuses a non-interactive stdin, refuses a declined answer, and — after an explicit yes — performs the takeover and releases the name again.

## Acceptance Criteria Traceability

| AC | Proven by |
|----|-----------|
| The squat is refused plainly and the operator is told the one recovery command | `tests/session-replacement.test.mjs` — "the defect: …" and "the client itself never takes a name: a squatted name is refused, not seized" |
| Same-Actor takeover: atomic, fenced, released; a foreign key never displaced | `tests/session-replacement.test.mjs` — "the defect: …", "a foreign key can never take the name …", "a failed durable write leaves the incumbent intact", "the displaced session's late requests cannot land …" |
| Nothing else changes; an orderly exit needs no takeover | `tests/session-replacement.test.mjs` — "the takeover leaves the Actor's OTHER names …", "the MCP adapter hands its name back when its stdin closes" |
