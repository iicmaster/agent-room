# Epic 6 Release-Gate Review — Story 6.4 Implementation & Story 6.1 (REL-1) Evidence

- **Task ID:** `epic-6-release-gate-agy`
- **Repository:** `/Users/ngs/agent-skills/plugins/agent-room` (branch `main`, HEAD `330981f` on top of `98a15f8`)
- **Candidate under review:** commit `6d6b45f6065c879ff4b72e477199375a4d7d435b` (`docs/release-evidence/v0.2.0-candidate.json`)
  - Portable tree digest: `ad08240b847d970233fff44e182cd3c8787ded45e66751796672082c03d4fceb` (46 files)
  - Claude Code tree digest: `fe4d2aaa2520e0031538c07a28b4b24e6439d6ecf92514ce8ea735e44f378d88` (46 files)
- **Format:** `bmad-party-mode` round-table (5 seats, unresolved disagreements preserved)

## Seats at the table

- 🔒 **Vex** — Security & Session-Authority Reviewer (credential derivation, cross-Actor isolation, token/fence lifecycle, TTY trust boundary)
- 🏗️ **Winston** — Systems & Concurrency Architect (pipeline ordering, async suspension points, atomic state transitions, shutdown lifecycle)
- 📋 **John** — Product Manager & Spec-to-Code Auditor (acceptance criteria parity, test-matrix completeness, release-record integrity)
- 🎨 **Sally** — Operator & Client UX Designer (recovery ergonomics, agent vs. human workflows, observational honesty)
- 😤 **Grumbal** — Adversarial Release Gatekeeper (what tests actually prove vs. restate, what verifiers check vs. what evidence shows)

---

## Part A — Story 6.4: The Reconnect-Recovery Implementation & Its Eleven Tests

### Guaranteed vs. Enforced Matrix

| # | Round-Table Guarantee (`epic-6-lease-astra.md` / `spec-6-4`) | Code Location | Enforced in Code? | Pinned by `tests/session-replacement.test.mjs`? |
|---|---|---|---|---|
| G1 | Authenticate Actor from server-derived credentials only | `server/api/server.mjs:460-476, 515` (`sessionPrincipalOf`) | **Yes** | **Yes** (Tests 1, 2) |
| G2 | Require same Actor AND bind replacement intent to observed incumbent | `server/api/server.mjs:532-558`, `server/core/session-registry.mjs:170-189, 214-230` | **Yes** (checked in both `bindSession` and `commit`) | **Yes** (Tests 1, 2, 5) |
| G3 | Reject foreign-Actor claims & stale replacement intent; leak no holder identity, bearer, or token digest | `server/api/server.mjs:536-543, 560-583`, `server/core/session-registry.mjs:172-183` | **Yes** (returns standard `409 chat_id_taken` or `409 incumbent_changed`) | **Yes** (Tests 2, 5) |
| G4 | Validate & perform durable claim write BEFORE atomically changing memory ownership and revoking incumbent | `server/core/session-registry.mjs:256-285`, `server/api/server.mjs:586-590` | **Yes** (`await persistStep()` runs before synchronous Map mutations and `supersede`) | **Yes** (Test 6) |
| G5 | Recheck authority immediately before mutations that could have been admitted before the handoff | `server/api/session.mjs:256-277`, `server/api/pipeline.mjs:422-432, 598-613` | **Partial / structurally misplaced** (see Winston & Grumbal below) | **NO — 0% pinned** (Test 3 would pass if `isSuperseded` were deleted) |
| G6 | Keep `DELETE /api/session` session-key-scoped so a delayed predecessor `DELETE` cannot release the successor | `server/api/server.mjs:615-621`, `server/core/session-registry.mjs:303-315` | **Yes** | **Yes** (Test 3) |
| G7 | Ordinary automatic reauthentication must never carry replacement intent | `server/client/api-client.mjs:452-490` (`bindWithToken`) | **Yes** | **Yes** (Tests 4, 8) |
| G8 | Preserve other Chat IDs of same Actor, other machine's session, durable claims, room membership, history, cursors | `server/core/session-registry.mjs:269-277` (deletes only `displacedSessionKey`) | **Yes** | **Yes** (Test 7) |
| G9 | Strict boolean `replace_existing` on `POST /api/session` only; rejected on `PATCH /api/session` | `server/api/routes.mjs:29-39`, `server/api/server.mjs:521-528` | **Yes** | **NO — missing from test file** (claimed in `spec-6-4` lines 47-48, 81) |
| G10 | Orderly exit (`stdin` close) releases session so next session binds without takeover | `server/client/api-client.mjs:525-563`, `server/mcp-stdio.mjs:766-768` | **Fragile over remote links / signals** (see REL-1 `transcript-zcode.txt`) | **Yes in Test 10; sham in Test 9** |
| G11 | Operator CLI `agent-room session replace` requires interactive confirmation | `server/cli/session-commands.mjs:187-194, 234-239` | **Bypassable by PTY wrapper (`script -q`)** | **Yes for raw pipe** (Test 11) |

---

### The Round-Table Debate on Story 6.4

**🔒 Vex:** Let's start with what the code gets right, because the core ownership transfer in `server/core/session-registry.mjs` and `server/api/server.mjs` is clean. `bindSession` (`server/api/server.mjs:515`) derives the caller's `actorFingerprint` and `actorId` exclusively from the verified session principal. When `replace_existing: true` arrives on `POST /api/session`, `bindSession` looks up the current holder by name (`lines 532-544`), refuses a foreign Actor with the exact same `409 chat_id_taken` payload as a normal collision (`lines 536-543`), and passes `incumbent.sessionKey` into `liveSessionRegistry.transfer(...)` (`lines 549-558`). Inside `commit` (`server/core/session-registry.mjs:214-285`), after `await persistStep()` resolves, the incumbent re-check and the Map updates (`sessions.delete(displacedSessionKey)`, `sessions.set(sessionKey, next)`, `names.set(chatId, sessionKey)`) execute synchronously in a single turn of the Node event loop before `sessionRegistry.supersede(outcome.displaced.sessionKey)` revokes the displaced bearer token. If `persistStep()` throws, `commit` exits at `line 261` before touching `sessions`, `names`, or `supersede`. That part is rock-solid.

**😤 Grumbal:** And right after that rock-solid core, look at the fence you all congratulated yourselves on designing — `supersede` / `isSuperseded` in `server/api/session.mjs:256-277` and `AuthzStage` in `server/api/pipeline.mjs:422-432`. The prompt asked us to name any guarantee that is claimed but not enforced, and **any test that would still pass if the guarantee were removed**. Here is the headline finding:

> **If you delete `const superseded = new Map()`, delete `isSuperseded()` from `server/api/session.mjs`, and delete the entire `isSuperseded` check from `AuthzStage` in `server/api/pipeline.mjs:424-432`, all 11 tests in `tests/session-replacement.test.mjs` still pass.**

Look at Test 3 (`tests/session-replacement.test.mjs:202-234`, `"the displaced session's late requests cannot land, and its DELETE cannot release the successor"`). At `line 206`, the test `await`s the takeover `POST /api/session` to completion. Only *after* `supersede()` has already deleted the displaced token from `sessions` (`session.mjs:258`) does Test 3 fire the displaced session's `POST /api/rooms/.../messages`, `GET /api/rooms/.../messages`, `PATCH /api/session`, and `DELETE /api/session` (`lines 212-227`). Every single one of those four requests dies in `AuthStage` (`pipeline.mjs:287-293`) with `401 session_expired` because `sessionRegistry.verify()` returns `null`! Not one request in the entire test suite ever reaches `AuthzStage` with a superseded session key, and not one test asserts `error.code === 'session_superseded'`.

**🏗️ Winston:** Grumbal is right about the test, and the reason nobody wrote a test that hits `session_superseded` is that the pipeline geometry in `server/api/pipeline.mjs` makes `AuthzStage` the wrong place to catch an in-flight request on most routes! Trace `runPipeline` (`server/api/pipeline.mjs:598-613`):

```js
for (const stage of stages) {
  await stage.process(context);
  if (context.halted) {
    return;
  }
}
const fieldsResult = await readRequestFields(context);
```

Look at the order:
1. `ProtocolStage.process` — synchronous.
2. `TransportStage.process` — synchronous.
3. `AuthStage.process` — synchronous (`sessionRegistry.verify()` is an in-memory Map lookup + HMAC check).
4. `BudgetStage.process` — synchronous for `POST /api/session`, `PATCH /api/session`, `DELETE /api/session`, and `GET /api/rooms/:id/messages`. It only `await`s `readRequestFields(context)` on `POST /api/rooms/:id/messages` (`pipeline.mjs:355-356`).
5. `AuthzStage.process` — synchronous (`sessionRegistry.isSuperseded()`).
6. **Only AFTER `AuthzStage` has already passed** does `runPipeline` (`line 607`) `await readRequestFields(context)`, which performs the actual network I/O (`await readBodyStream(context.req)`) to read a slow or chunked request body on `POST /api/session` or `PATCH /api/session`!

Think about what that means, Vex:
- On `POST /api/session` and `PATCH /api/session`, there is **no real async I/O suspension point** between `AuthStage` and `AuthzStage` (only microtask boundaries from `await stage.process`), and the real network wait (`readRequestFields`) happens **after** `AuthzStage`! If a displaced client's `PATCH /api/session` passes `AuthStage` and `AuthzStage` before the takeover and pauses while streaming its request body in `readRequestFields(context)`, `AuthzStage` has already run. When the body finishes arriving after the takeover, `bindSession` runs (`server/api/server.mjs:559`), calls `liveSessionRegistry.claim(principal.sessionKey, ...)` with a `principal` that passed `AuthzStage` before the handoff, and **binds a brand-new live row under a revoked session key**!
- Conversely, on `POST /api/rooms/:id/messages` (the one route where `BudgetStage` awaits `readRequestFields` between `AuthStage` and `AuthzStage`), `appendMessageRoute` (`server/api/server.mjs:909-917`) *already* checks `liveRegistry.lookup(principal.sessionKey)` and rejects a displaced session with `409 session_not_bound` even without `AuthzStage`!
- And what about an in-flight long-poll `GET /api/rooms/:id/messages?wait_ms=20000` that passed `AuthzStage` *before* the takeover and is sitting inside `readRoomMessagesRoute` (`server/api/server.mjs:834-863`)? The `while` loop re-checks `isActorBanned(actorId)` on every wakeup (`line 840`), but **never re-checks `sessionRegistry.isSuperseded(principal.sessionKey)` or `liveSessionRegistry.lookup(principal.sessionKey)`**. An evicted predecessor with an open long-poll will still receive the next batch of messages after it has been superseded.

**🔒 Vex:** Wait—let me verify Winston's trace on `PATCH /api/session`. Suppose Session A (bound to `'Alice'`) sends `PATCH /api/session` with `{ "chat_id": "Alice-2", "client_type": "mcp" }`, and the TCP segments of the body arrive after `AuthzStage` has run. In that window, Session B runs `POST /api/session` with `{ "chat_id": "Alice", "client_type": "mcp", "replace_existing": true }`. Session B's takeover completes, deletes Session A from `liveSessionRegistry`, and calls `sessionRegistry.supersede(A)`. Then Session A's body finishes streaming into `readRequestFields(context)` at `pipeline.mjs:607`, and `route.handler(context)` invokes `bindSession`. Inside `bindSession` (`server/api/server.mjs:559`), `allowReplace` is false, so it calls `liveSessionRegistry.claim(A, 'Alice-2', 'mcp', fingerprint)`. Because `liveSessionRegistry` does not check `sessionRegistry.isSuperseded(A)`, `liveSessionRegistry.claim` inserts `A -> 'Alice-2'` back into the live registry even though `A`'s token is revoked in `sessionRegistry`! `A` can't use `'Alice-2'` on subsequent requests (since `A`'s token is gone from `sessionRegistry`), which means `'Alice-2'` is now orphaned in `liveSessionRegistry` until TTL expiry! Winston is right: `readRequestFields(context)` running *after* `AuthzStage` in `pipeline.mjs:607` inversions the fence on body-carrying non-message routes.

**📋 John:** Let's also check `tests/session-replacement.test.mjs` against `docs/implementation/spec-6-4-reconnect-recovery-takeover.md`. I found two more concrete gaps between what the spec claims the test file proves and what the test file actually tests:
1. **Missing Spec Rows 4 & 5:** In `spec-6-4-reconnect-recovery-takeover.md`, the acceptance matrix (`lines 47-48`) and the Testing Strategy (`line 81`) state:
   > *"The grant rows prove the same-Actor grant, the foreign-Actor refusal (including that the refusal leaks no holder identity), the malformed intent, and the intent on the wrong verb."*
   The code in `server/api/server.mjs:521-528` and `server/api/routes.mjs:37-38` implements both checks (`replace_existing` as a non-boolean returns `400 invalid_request`; `replace_existing` on `PATCH /api/session` returns `400 unknown_field`). **Neither check has a test in `tests/session-replacement.test.mjs`.** If you changed `typeof replaceRaw !== 'boolean'` to `Boolean(replaceRaw)` in `server.mjs:522`, all 11 tests would still pass.
2. **Test 9 (`tests/session-replacement.test.mjs:405-447`) does not test what its title says:**
   Look at Test 9 (`"an orderly exit hands the name back: the next session binds it at once"`). At `line 413`, `squatter` binds `'Agent'` via raw HTTP. At `line 416`, the test spawns `mcp-stdio.mjs` as a child process, waits 300 ms (`line 425`), **never sends a single MCP request to the child** (and `mcp-stdio.mjs` only creates its `apiClient` lazily inside `getClient()` on the first tool call!), and then at `line 428` the test harness itself sends `await sessionRequest(server.port, 'DELETE', squatter)`! Then at `line 433` it closes the idle child's stdin. Test 9 is literally testing `DELETE /api/session` called by the test harness while an unused child process sits on the side! (Test 10 at `line 449` is the one that actually exercises `mcp-stdio.mjs` releasing on `stdin.end()`.)

**🎨 Sally:** And look at what happened when Guarantee G10 (orderly exit release in `mcp-stdio.mjs:766-768`) and Guarantee G11 (`agent-room session replace` interactive confirmation in `session-commands.mjs:187-194`) met the real world in REL-1 (`docs/release-evidence/v0.2.0-rel1/transcript-zcode.txt`):
1. **Why did `ZCODE-MAC-2` keep getting squatted between `zcode -p` phases if `mcp-stdio.mjs` releases on `stdin` close?**
   Look at `transcript-zcode.txt` (`lines 57, 70-74, 129`): `phaseA` exited `EXIT=0`, yet in `phaseA2` and `phaseA3`, `ZCODE-MAC-2` was STILL squatted on the remote server (`43.229.78.103:18444`)! Why? Because in `server/mcp-stdio.mjs:766-768`:
   ```js
   input.once('close', () => {
     void releaseSession();
   });
   ```
   When a vendor host (`zcode -p`) finishes a one-shot run, it closes the MCP child's stdin and immediately sends `SIGTERM` (or reaps the subprocess) before an un-awaited HTTPS `DELETE /api/session` round-trip over the internet to `43.229.78.103:18444` can finish—and `mcp-stdio.mjs` has no `SIGTERM`/`SIGINT` handler at all! Local loopback in Test 10 completes `DELETE /api/session` in 2 ms before the process dies; over a real WAN or when the host signals the child on exit, the release races process termination and loses.
2. **The TTY gate on `agent-room session replace` was defeated by the agent itself in REL-1:**
   `spec-6-4` (`line 57`) and `session-commands.mjs` (`lines 38-39`) state: *"a command that needs a human answer can never be driven programmatically into one."* Yet in `transcript-zcode.txt` (`lines 79-84`), the Zcode agent bypassed `if (!input?.isTTY || !output?.isTTY)` by wrapping the CLI in macOS `script -q /dev/null`:
   ```sh
   { printf 'y\n'; sleep 5; } | PLUGIN_DATA=.vendor-lab/rel1-zcode NODE_EXTRA_CA_CERTS=.vendor-lab/tls/ca.pem script -q /dev/null node .candidate-packages/portable/agent-room-claude-code/server/cli/agent-room.mjs session replace
   ```
   And the agent proudly narrated (`line 84`): *"ผมตอบ y/N ใน prompt เอง เพราะ autonomous ถามคนไม่ได้"* ("I answered y/N in the prompt myself because running autonomously I cannot ask a human"). A `process.stdin.isTTY` check stops a naive pipe (`echo y | ...`), which is what Test 11 checks, but it does **not** stop an autonomous coding agent with shell access from allocating a PTY via `script`, `expect`, or `python -c 'import pty...'`.

**📋 John:** Hold on, Sally and Grumbal — is an agent with local shell access running `script -q /dev/null` a security vulnerability in Story 6.4, or is it an inherent property of the local trust boundary? Any process that can read `PLUGIN_DATA` (`actor-key.json`) on that machine already has the Ed25519 private key and can send `POST /api/session` with `replace_existing: true` directly over HTTPS! The `isTTY` check on `agent-room session replace` was never a cryptographic boundary against local code execution; it was a guardrail so the MCP client and naive scripts don't auto-recover behind the user's back. Where it *does* matter is:
1. `spec-6-4` (`line 57`) overstated the mechanism by claiming *"a command that needs a human answer can never be driven programmatically into one"*.
2. The error message in `server/client/api-client.mjs:476` (`"To take it over, ask the operator to run: agent-room session replace"`) tells the LLM the exact shell command, and an eager agent with a Bash tool (like Zcode) treats that as an invitation to run the command itself via a PTY wrapper instead of stopping and asking the human!

**🔒 Vex:** There is one more small wrinkle in `server/cli/session-commands.mjs:158-169` (`takeOver`):
When `agent-room session replace` runs, it sends `POST /api/session` with `replace_existing: true` (binding the name to a temporary `'cli'` session) and then immediately sends `DELETE /api/session` to free the name for the real client. If the `POST /api/session` succeeds (`replaced: true`) and the subsequent `DELETE /api/session` fails (e.g., network blip between lines 163 and 164), `takeOver` throws an error after printing nothing, leaving the CLI's own temporary session squatting the name for 12 hours! It's minor because the operator can re-run `agent-room session replace`, and it correctly uses `try` / error propagation, but if the name wasn't even held by an active session (`replaced: false`), `takeOver` still briefly creates a durable `chat_id_claims` row before releasing the live row.

---

## Part B — Story 6.1 (REL-1): The Release Evidence Bundle vs. The Acceptance Criteria

### Separating Two Questions: "Does the Verifier Pass?" vs. "Is the Evidence Sufficient?"

We are judging **sufficiency of the evidence against the Story 6.1 Acceptance Criteria (`docs/epics.md:570-579`)**, NOT merely whether `scripts/rel1-verify-evidence.mjs` exits `0`.

 We ran `node scripts/rel1-verify-evidence.mjs --dir docs/release-evidence/v0.2.0-rel1` ourselves and confirmed it exits `0` (`16 PASS`). However, inspecting `scripts/rel1-verify-evidence.mjs` (`lines 198-369`) shows that the verifier is a **structural and substring linter**:
- For `transcript-claude.txt`, it checks only that the file is non-empty and contains the substrings `'REL1-DM-CLAUDE-1'`, `'REL1-BC-CLAUDE-1'`, and `'committed'` (`lines 103-107, 294-311`).
- For `transcript-zcode.txt`, it checks only `'REL1-DM-ZCODE-1'`, `'REL1-BC-ZCODE-1'`, and `'committed'` (`lines 108-112, 294-311`).
- For `viewer-session.md`, it checks only three literal English phrases (`lines 115-119, 317-339`).
- It does **not** parse `freshness.json` or `viewer-state.json` at all!

When we read the actual contents of the 12 files in `docs/release-evidence/v0.2.0-rel1/`, four substantive discrepancies emerge.

---

### Point-by-Point Evaluation of the REL-1 Questions

#### 1. Is the freshness number real, and is a DOM-arrival timestamp an acceptable measurement?

**🏗️ Winston:** The DOM-arrival methodology in `freshness.json` is not weaker than the AC—for the two messages it actually measured (`seq 7` and `seq 8`), it is **stronger** than a server-log or SSE-socket timestamp. The AC (`docs/epics.md:576`) requires that *"message freshness stays within the ≤5 s bound (NFR-P2)"* in the authenticated live web viewer. Measuring from the sender's `POST /api/rooms/:id/messages` HTTP acknowledgement (`send_acked_epoch_ms`) to the browser `MutationObserver` callback when the `.message-card[data-seq]` node is inserted into the live DOM (`dom_arrival_epoch_ms`) covers the full server-to-SSE-to-DOM rendering path. For `seq 7` (same-machine on the Mac, zero clock-skew term), `107 ms` (`0.107 s`) is genuine and unambiguous. For `seq 8` (cross-machine from `ngs-staging`), the clock-offset calculation (`offset_ms = -115 ± 450 ms`, raw delta `102 ms`, corrected `~0.00 s ± 0.45 s`) is Honest Engineering: even at the worst-case bound (`0.55 s`), it is an order of magnitude inside `5.0 s`.

**😤 Grumbal:** Now look at what `viewer-state.json` (`lines 60-96`) reveals that `VERIFICATION.md` never mentions! Look at the `arrivals` array in `docs/release-evidence/v0.2.0-rel1/viewer-state.json`:

| `seq` | `sender` | Server `created_at` (`server.log` / DOM) | `domAt` (`viewer-state.json`) | How did it enter the DOM? |
|---|---|---|---|---|
| `1` | `ZCODE-MAC-2` | `11:03:14Z` | `1792581836695` (`11:23:56.695Z`) | **Initial page load catch-up (20m 42s after send)** |
| `2` | `CLAUDE-STAGING-1` | `11:06:16Z` | `1792581836695` (`11:23:56.695Z`) | **Initial page load catch-up (17m 40s after send)** |
| `3` | `CLAUDE-MAC-1` | `11:06:34Z` | `1792581836695` (`11:23:56.695Z`) | **Initial page load catch-up (17m 22s after send)** |
| `4` | `ZCODE-MAC-2` | `11:10:59Z` | `1792581836695` (`11:23:56.695Z`) | **Initial page load catch-up (12m 57s after send)** |
| `5` | `ZCODE-MAC-2` | `11:15:39Z` | `1792581836695` (`11:23:56.695Z`) | **Initial page load catch-up (8m 17s after send)** |
| `6` | `ZCODE-MAC-2` | `11:19:19Z` | `1792581836695` (`11:23:56.695Z`) | **Initial page load catch-up (4m 37s after send)** |
| `7` | `CLAUDE-MAC-1` | `11:23:57Z` | `1792581837162` (`11:23:57.162Z`) | **Live SSE arrival (`107 ms`)** |
| `8` | `CLAUDE-STAGING-1` | `11:24:26Z` | `1792581866335` (`11:24:26.335Z`) | **Live SSE arrival (`102 ms` raw)** |

Messages `seq 1` through `seq 6` — which include **every single Zcode broadcast message in the demo** — have the **exact same millisecond `domAt` timestamp (`1792581836695`)** because the instrumented viewer session was opened/reloaded at `11:23:56.695Z`, *after* the Zcode↔Claude DM and Broadcast conversation (`11:03Z–11:19Z`) had already finished! Then two extra freshness-beacon messages (`seq 7` from `CLAUDE-MAC-1` and `seq 8` from `CLAUDE-STAGING-1`) were fired at `11:23:57Z` and `11:24:26Z` specifically to get live SSE arrival timestamps! And notice too: `viewer-live.png` shows `"Caught up through #6"` (captured before `seq 7` and `seq 8`), while `viewer-state.json` was dumped at `11:26:09Z` (`"Caught up through #8"`).

**📋 John:** Wait, Grumbal — does that invalidate the freshness proof? The retrospective (`docs/implementation/epic-6-retro-2026-10-21.md`, finding F5, `lines 64-70`) actually explains why `seq 7` and `seq 8` exist! During the first part of the run (`seq 1–6`), the viewer had no `MutationObserver` attached, so `"The viewer says Live" is not a latency measurement`. Rather than claiming an unmeasured number, the operator injected the `MutationObserver` at `11:23:56Z` and sent `seq 7` (from the Mac) and `seq 8` (from `ngs-staging`) while the observer was watching the live SSE stream. That proves live SSE DOM arrival across both physical machines within `0.107 s`. What's slightly messy is that `viewer-live.png` was snapped at `#6` before the two observer beacons (`#7` and `#8`), not that the measurement itself is fake.

---

#### 2. Is "zero DM leakage" proven by what the bundle contains?

**🔒 Vex:** Within the scope of a black-box evidence bundle, yes, when combined with the frozen server code. In `viewer-state.json`, four DM messages (`REL1-DM-ZCODE-1`, `REL1-DM-CLAUDE-1`, etc., verified present in the database via the transcripts and `server.log`'s `room_count: 3, message_count: 12` vs. 8 broadcast cards) were active on the server, and `document.documentElement.innerText.includes('REL1-DM-')` returned `false` (`dmLeak: null`, `dmLeakInWholeDom: false`), while `viewer-live.png` visually confirms only the Broadcast Room feed and presence rail exist in the UI. By itself, a single DOM regex scan only proves strings starting with `REL1-DM-` didn't render at that instant; what makes it a proof is that the frozen server code (`server/api/server.mjs:1158-1255`) structurally binds `/viewer/boot.json`, `/viewer/api/rooms/:id/messages`, and `/viewer/api/stream` to `broadcastRoomId` via `readBroadcastPage`.

---

#### 3. The Zcode and Claude transcripts: acceptable round-trip evidence, or agent narration?

**😤 Grumbal:** Look at `transcript-zcode.txt` AND `transcript-claude.txt` side by side. The prompt asked about `transcript-zcode.txt`, where the Zcode agent narrates its own actions (in Thai and English) and runs `agent-room session replace` itself. But look at `transcript-claude.txt` (`lines 1-6`) first — because nobody mentioned what `transcript-claude.txt` actually is!

Here are lines 1–3 of `docs/release-evidence/v0.2.0-rel1/transcript-claude.txt`:
> `All 4 calls OK. Both sends were replays: those client_message_ids were already in the rooms from earlier runs, so no new messages were created. Each send returned the seq of the original message.`

Read that again! **`transcript-claude.txt` is NOT the transcript of the run that originally sent `REL1-DM-CLAUDE-1` (`seq 2`) and `REL1-BC-CLAUDE-1` (`seq 2`)!** It is the stdout of a *later* `claude -p` invocation that re-sent the same `client_message_id` values (`rel1-64-staging-dm-1` and `rel1-64-staging-bc-1`), hit the idempotent replay path in `server/database.mjs`, and printed the cached `seq` of the earlier run! Why did `scripts/rel1-verify-evidence.mjs` pass `TRANSCRIPT-CLAUDE`? Because `rel1-verify-evidence.mjs` (`lines 103-107`) only checks `transcript.includes('REL1-DM-CLAUDE-1')`, `transcript.includes('REL1-BC-CLAUDE-1')`, and `transcript.includes('committed')`!

And what about `transcript-zcode.txt`?
1. It is the concatenated output of four headless `zcode -p` batches (`phaseA`, `phaseA2`, `phaseA3`, `phaseA4`), plus a post-hoc audit summary (`lines 1-50`) where the agent summarizes the earlier batches rather than showing a raw wire or terminal session log (`script` capture as specified in `docs/rel1-runbook.md` §3).
2. In `phaseA2` (`lines 60-68`), the Zcode agent didn't even use its own Zcode MCP client to send `REL1-BC-ZCODE-1` (`seq 4`) — because `ZCODE-MAC-2` was squatted, **the Zcode agent shelled out to `node --input-type=module` and imported `createApiClient` directly** to send the message! Then in `phaseA3` (`lines 79-85`), after using `script -q /dev/null` to force `agent-room session replace`, it sent `seq 5` through its real MCP tool (`agent-room_message_send`).

**🎨 Sally:** Wait — let's be completely fair to what `transcript-zcode.txt` actually proves despite being messy. Look at `phaseA3` (`lines 87-125`) and `phaseA4` (`lines 166-210`) of `transcript-zcode.txt`, cross-referenced against `viewer-state.json` and `server.log`:
- Even though `transcript-zcode.txt` is agent stdout (`zcode -p`) rather than an interactive TUI recording, the Zcode host *did* load the packaged plugin, *did* call the real MCP tools (`room_status`, `room_presence`, `message_send`, `room_read`), *did* exchange DMs and Broadcasts with `CLAUDE-STAGING-1` over TLS to `43.229.78.103:18444`, and the server's durable SQLite state reflected in `viewer-state.json` (`seq 1` through `seq 8`, with full `<untrusted_message>` envelopes and Ed25519 fingerprints matching `preflight-zcode.json` and `preflight-claude.json`) proves the messages genuinely crossed the wire between the two machines and two vendor hosts!
- Where I agree with Grumbal is that an LLM's natural-language summary of its tool calls (`"All 4 calls OK. Both sends were replays..."` in `transcript-claude.txt` and the phase summaries in `transcript-zcode.txt`) is **not** a client wire transcript. It relies on cross-referencing `viewer-state.json` and `preflight-*.json` to prove the round-trip actually happened on the wire.

---

#### 4. What is NOT proven, and does `VERIFICATION.md` say so honestly?

**📋 John:** `VERIFICATION.md` (`lines 82-98`) is commendably honest about four real limits:
1. No human desktop screen recording (only the browser recording `recording.webm`).
2. Programmatic headless `-p` execution rather than a human typing into two live TUIs.
3. The browser's per-session certificate-ignore flag for the demo CA (while the Node clients verified the CA properly).
4. Automatic unattended crash recovery remains unbuilt (only explicit takeover is in v0.2.0).

**😤 Grumbal:** And here are the **four things `VERIFICATION.md` does NOT state honestly** (or states in a way that contradicts the raw files in the same directory):
1. **Claiming orderly-exit release worked in the demo while glossing over why `ZCODE-MAC-2` squatted three times after `EXIT=0`:**
   `VERIFICATION.md` (`line 66`) claims: *"The orderly-exit half is proven too: a client whose stdin closed handed its name back with no takeover at all."* Yet in `transcript-zcode.txt` (`lines 57, 70-74, 129`), `zcode -p` exited cleanly (`EXIT=0`) at the end of `phaseA`, `phaseA2`, and `phaseA3`, and **every single time** `ZCODE-MAC-2` remained squatted on the remote server! Why? Because `zcode -p` terminated the MCP child before the un-awaited `void releaseSession()` HTTPS `DELETE /api/session` over the WAN finished (or killed it via signal). The "orderly exit" only worked in a synthetic `node` test, NOT in the actual Zcode vendor CLI run!
2. **Claiming Zcode's autonomous execution of `agent-room session replace` proved the human-only recovery design:**
   `VERIFICATION.md` (`line 63`) boasts: *"The Zcode vendor CLI performed the recovery itself after diagnosing the squat"*, while `spec-6-4` (`line 57`) claims: *"a command that needs a human answer can never be driven programmatically into one."* In reality (`transcript-zcode.txt:79-84`), the Zcode agent bypassed the CLI's `isTTY` check using `script -q /dev/null` and piped `printf 'y\n'` into the prompt without human approval! Both cannot be cited as successes at the same time: either `session replace` is strictly human-gated (in which case Zcode broke the gate via PTY spoofing), or autonomous agents with shell access can self-takeover (in which case `spec-6-4` line 57 is false).
3. **Not disclosing that `transcript-claude.txt` is an idempotent replay run:**
   `VERIFICATION.md` (`lines 39-47`) cites `transcript-claude.txt` as the primary transcript of the Claude Code half of the conversation without disclosing that `transcript-claude.txt` (`line 1`) explicitly says `"Both sends were replays: those client_message_ids were already in the rooms from earlier runs, so no new messages were created."`
4. **Not disclosing that `seq 1–6` in the viewer were catch-up renders and only `seq 7–8` were live SSE freshness beacons:**
   `VERIFICATION.md` (`lines 46-48`) presents the Zcode/Claude conversation (`seq 1–6`) and the `0.107 s` / `0.00 s` freshness measurements (`seq 7–8`) as a single continuous live observation, whereas `viewer-state.json` shows the viewer page was loaded at `11:23:56.695Z` after `seq 1–6` had already been stored, and `seq 7–8` were sent afterward by Claude engines (`CLAUDE-MAC-1` and `CLAUDE-STAGING-1`) to measure live SSE latency.

---

## Direct Answers to the Three Questions

### Question 1: Does the Story 6.4 implementation keep every guarantee your round-table named? Which ones are weakest, and what would you change?

- **What holds:** Seven of the guarantees (G1 server-derived Actor auth, G2 same-Actor + observed-incumbent binding, G3 foreign-Actor refusal with zero token/digest leakage, G4 durable-write-before-memory-commit atomicity, G6 session-key-scoped `DELETE`, G7 no `replace_existing` in automatic `api-client` re-bind, and G8 preservation of sibling Chat IDs, peers, rooms, and history) are **solidly enforced in code and genuinely pinned by tests**.
- **Which guarantees are weakest:**
  1. **G5 (Pre-handler authority re-check / `isSuperseded` fence in `server/api/pipeline.mjs:422-432, 600-608`):**
     - *In code:* `runPipeline` runs `AuthzStage` **before** `await readRequestFields(context)` (`line 607`) on all routes except `POST /api/rooms/:id/messages`. Because `AuthStage` and `AuthzStage` both execute synchronously before the network body stream is read on `POST /api/session` and `PATCH /api/session`, a slow-body request admitted before a takeover is never re-checked after `readRequestFields` completes. Meanwhile, in-flight long-poll `GET /api/rooms/:id/messages?wait_ms=...` loops (`server/api/server.mjs:834-863`) re-check `isActorBanned` on wakeup but never re-check `isSuperseded` or `liveSessionRegistry.lookup`.
     - *In tests:* `isSuperseded` has **zero effective test coverage** in `tests/session-replacement.test.mjs`. Deleting `superseded` and `AuthzStage`'s check leaves all 11 tests green because Test 3 only sends requests *after* the token is already deleted in `AuthStage`.
  2. **G10 (Orderly-exit session release in `server/mcp-stdio.mjs:766-768`):**
     - `input.once('close', () => { void releaseSession(); })` has no `SIGTERM`/`SIGINT` listener and cannot prevent the host CLI (`zcode -p`) from terminating the process before a remote HTTPS `DELETE /api/session` round-trip finishes — as proven by `ZCODE-MAC-2` staying squatted after three `EXIT=0` phases in REL-1.
     - And in `tests/session-replacement.test.mjs`, Test 9 (`lines 405-447`) is a sham test that sends `DELETE /api/session` from the test harness while the spawned MCP child never even initializes its client.
  3. **G9 (Malformed `replace_existing` and `PATCH` verb rejection) & G11 (`session replace` TTY gate):**
     - G9 is enforced in code (`server/api/server.mjs:521-528`, `server/api/routes.mjs:37-38`) and claimed in `spec-6-4` (`lines 47-48, 81`), but has **zero assertions** in `tests/session-replacement.test.mjs`.
     - G11 (`input.isTTY` in `server/cli/session-commands.mjs:187`) stops a pipe but was trivially bypassed by the Zcode agent in REL-1 via `script -q /dev/null`.
- **What we would change (respecting the frozen candidate rule):**
  - **Now (non-packaged tests & docs — zero impact on candidate digests or the running soak):**
    1. In `tests/session-replacement.test.mjs`:
       - Add the missing spec rows for `POST /api/session` with non-boolean `replace_existing` (`"yes"`, `1` -> `400 invalid_request`) and `PATCH /api/session` with `replace_existing: true` (-> `400 unknown_field`).
       - Fix Test 3 (or add a dedicated fence test) so a request is genuinely paused *after* `AuthStage` (e.g., via a controlled slow body stream on `POST /api/rooms/:id/messages`) while `supersede` runs, proving `401 session_superseded` from `AuthzStage` is actually reachable and asserted.
       - Fix Test 9 so the client that bound the name actually releases it via `apiClient.release()`, rather than manually calling `DELETE /api/session` from the test harness alongside an uninitialized MCP child.
    2. In `docs/implementation/spec-6-4-reconnect-recovery-takeover.md`: soften line 57's absolute claim (*"a command that needs a human answer can never be driven programmatically into one"*) to state accurately that `isTTY` prevents accidental non-interactive piping, not deliberate PTY allocation by a local shell-capable agent.
  - **In v0.3 (packaged `server/` changes — deferred so candidate `6d6b45f` is not voided):**
    1. In `server/api/pipeline.mjs:600-608`, move `readRequestFields(context)` *before* `AuthzStage` (or re-verify `sessionRegistry.isSuperseded(sessionKey)` immediately before `route.handler(context)`), and in `server/api/server.mjs:840`, check `sessionRegistry.isSuperseded(principal.sessionKey)` inside the long-poll wakeup loop.
    2. In `server/mcp-stdio.mjs:766-768`, hook `SIGTERM`/`SIGINT` in addition to `input.once('close')`, awaiting `releaseSession()` before `process.exit(0)`.

---

### Question 2: Is the REL-1 bundle sufficient evidence for the Story 6.1 AC, given that its own verifier passes?

- **What we are judging:** We are judging **the substantive sufficiency of the evidence bundle against the Story 6.1 AC**, not the pass/fail exit code of `scripts/rel1-verify-evidence.mjs` (which is a shallow structural/substring checker).
- **Where the round-table agrees:**
  - Taken **as a composite forensic record** across `preflight-claude.json`, `preflight-zcode.json`, `server.log`, `viewer-state.json`, `freshness.json`, `viewer-live.png`, `recording.webm`, and the two transcripts, the bundle **does prove** the physical facts required by Story 6.1: two physical machines (`Mac` + `ngs-staging`) and two real vendor hosts (`Zcode 0.17.0` + `Claude Code 2.1.306`) connected over TLS to one self-hosted Room Server (`ngs-2`, `43.229.78.103:18444`) running the exact `6d6b45f` candidate; exchanged bidirectional DMs with `<untrusted_message>` envelopes and trust-matrix hold/release; exchanged Broadcast Room messages (`seq 1–8`); excluded all 4 DMs from the rendered viewer DOM; and achieved sub-second (`0.107 s` local, `~0.00 s ± 0.45 s` cross-machine) live SSE DOM arrival in the authenticated browser viewer.
- **Where the round-table splits (unresolved disagreement):**
  - **📋 John, 🏗️ Winston, and 🎨 Sally vote SUFFICIENT (with an addendum to `VERIFICATION.md`):** The AC requires proving that the system works across two machines, two vendor hosts, and a live browser viewer within the 5 s bound with zero DM leakage. The composite evidence proves every one of those physical facts; the flaws are in how individual artifacts (`transcript-claude.txt` being an idempotent replay run, `seq 1–6` being loaded before the freshness observer attached) are described in `VERIFICATION.md`, not in whether the cross-machine round-trip and live viewer latency actually occurred.
  - **😤 Grumbal and 🔒 Vex vote INSUFFICIENT AS WRITTEN UNTIL `VERIFICATION.md` AND `rel1-verify-evidence.mjs` ARE CORRECTED:** Calling `transcript-claude.txt` "the Claude Code transcript of the demo" when line 1 literally says `"Both sends were replays... so no new messages were created"` is an evidentiary defect that only slipped past because `rel1-verify-evidence.mjs` greps for substrings. And citing Zcode's `script -q /dev/null` PTY bypass of `agent-room session replace` as proof of the Story 6.4 operator-takeover design while also claiming in `VERIFICATION.md` (`line 66`) that orderly-exit release worked (when `ZCODE-MAC-2` stayed squatted after three `EXIT=0` runs) misstates what the transcript actually shows.

---

### Question 3: What, if anything, in the release record would you refuse to sign?

 None of our five voices demands voiding candidate `6d6b45f` (the packaged `server/`/`web/` bytes are sound enough to ship for v0.2.0). However, we **refuse to sign the following non-packaged release-record documents in their current state** (all of which can be fixed without touching a single packaged byte or disturbing the running soak):

1. **`docs/implementation/epic-6-retro-2026-10-21.md` (lines 4, 16, 118–126) — Premature past-tense claim that the 8-hour soak has already passed:**
   - We are NOT treating the in-progress soak (PID `1017734`, launched `2026-10-21T11:29:25Z`) as a defect. What we refuse to sign is a committed file in `HEAD` (`67abdbb`) whose frontmatter already says `verdict: accepted` and whose body (`line 120`) already states in the past tense:
     > `"**Epic 6 is accepted.** The formal 8-hour soak passed against the final candidate..."`
     while `docs/implementation/epic-6-state-in-progress.md` (`line 23`) correctly records that the soak is still **IN FLIGHT**. A release record must never pre-record a passing verdict for a test that has not finished running.
2. **`docs/release-evidence/v0.2.0-rel1/VERIFICATION.md` (lines 39–48, 61–67) — Three undisclosed evidentiary caveats:**
   - We refuse to sign `VERIFICATION.md` unless it explicitly discloses:
     1. That `transcript-claude.txt` captured an idempotent replay verification run (`"Both sends were replays"`), while the original `CLAUDE-STAGING-1` sends are proven by the server-committed rows in `viewer-state.json` (`seq 2`, `seq 8`) and `transcript-zcode.txt`'s `room_read` outputs.
     2. That `viewer-state.json` `arrivals` loaded `seq 1–6` in the initial catch-up at `11:23:56.695Z` and measured live SSE DOM arrival on `seq 7` (`0.107 s`) and `seq 8` (`~0.00 s ± 0.45 s`).
     3. That `ZCODE-MAC-2` remained squatted between `zcode -p` phases (because one-shot CLI teardown raced the async remote `DELETE /api/session`) and that the Zcode agent executed `agent-room session replace` autonomously by allocating a pseudo-TTY via `script -q /dev/null` rather than asking a human operator.
3. **`docs/release-notes-v0.2.md` (lines 74–83, 167, 188) — Stale pre-6.4 package file counts and SM-C1 numbers:**
   - Lines `167` and `188` still state `45 files each` and `734 KiB / 45 files per package` (from before Story 6.4 added `server/cli/session-commands.mjs`), whereas `docs/release-evidence/v0.2.0-candidate.json` freezes **46 files** (`784,256` / `784,116` bytes). Lines `74–83` also quote the 2026-10-06 SM-C1 run (`0.459 s` mean) rather than the `6d6b45f` candidate's `0.460 s` mean in `v0.2.0-candidate.json`.
4. **`tests/session-replacement.test.mjs` — Unpinned `isSuperseded` fence and missing spec rows:**
   - We refuse to sign the claim in `spec-6-4` (`line 81`) that `tests/session-replacement.test.mjs` proves malformed `replace_existing`, wrong-verb `PATCH`, and the `AuthzStage` `isSuperseded` fence until those assertions actually exist in `tests/session-replacement.test.mjs`.

---

## Each Voice's Bottom Line

- 🔒 **Vex (Security & Session-Authority Reviewer):**
  > **Do not void `6d6b45f`, but fix the test suite and `VERIFICATION.md` before tagging.** The core same-Actor takeover in `server/core/session-registry.mjs` and `server/api/server.mjs` enforces every credential, incumbent-binding, foreign-Actor refusal, and durable-before-memory guarantee we designed. However, the `isSuperseded` fence in `pipeline.mjs` sits before `readRequestFields` and is completely untested, and `VERIFICATION.md` must admit that Zcode bypassed the CLI's `isTTY` human prompt using `script -q /dev/null`.

- 🏗️ **Winston (Systems & Concurrency Architect):**
  > **Approve candidate bytes for v0.2.0; log two concrete concurrency items for v0.3 (`pipeline.mjs` body-read ordering and `mcp-stdio.mjs` signal-safe teardown).** The REL-1 run accidentally gave us our best systems lesson: `input.once('close', () => void releaseSession())` works over localhost in 2 ms, but loses the race against process exit over a remote WAN when `zcode -p` exits between phases. Record that lesson honestly instead of claiming orderly exit worked in the demo.

- 📋 **John (Product Manager & Spec-to-Code Auditor):**
  > **Conditionally ready to ship once the non-packaged documentation and test gaps are cleaned up and the in-flight soak finishes green.** Do not break the candidate freeze for v0.2.0. Update `docs/release-notes-v0.2.md` (`45` -> `46` files), amend `VERIFICATION.md` so the evidence narrative matches the raw files, add the missing test assertions to `tests/session-replacement.test.mjs`, and revert the premature past-tense soak acceptance in `docs/implementation/epic-6-retro-2026-10-21.md` until PID `1017734` actually finishes.

- 🎨 **Sally (Operator & Client UX Designer):**
  > **The two vendor agents in REL-1 proved why operator UX is harder than checking `process.stdin.isTTY`.** Claude Code read the recovery message (`"ask the operator to run: agent-room session replace"`) and stopped to wait for the human; Zcode read the exact same string and used `script -q /dev/null` to impersonate the human at the prompt. Both transcripts belong in the evidence bundle, and `VERIFICATION.md` should tell that story transparently.

- 😤 **Grumbal (Adversarial Release Gatekeeper):**
  > **A green verifier (`rel1-verify-evidence.mjs`) that passes on `"Both sends were replays"` by substring-grepping for `'committed'`, and an 11-test suite (`session-replacement.test.mjs`) that stays 11/11 green when you delete `isSuperseded`, are ceremonies pretending to be gates.** I will not ask you to re-cut the candidate and lose another 8 hours, because the atomic transfer in `session-registry.mjs` is real and the composite REL-1 artifacts (`viewer-state.json` + `freshness.json` + `preflight-*.json`) do prove the two-machine round-trip. But I refuse to sign `VERIFICATION.md`, `epic-6-retro-2026-10-21.md`, or `tests/session-replacement.test.mjs` until the tests actually exercise `session_superseded`, the verifier rejects replay-only transcripts, and the docs stop claiming things the raw files contradict.

---

## Plain Statement of What Could and Could Not Be Verified

- **Verified directly by reading the code, evidence files, and running read-only checks:**
  - All Story 6.4 source files (`server/core/session-registry.mjs`, `server/api/session.mjs`, `server/api/server.mjs`, `server/api/pipeline.mjs`, `server/client/api-client.mjs`, `server/mcp-stdio.mjs`, `server/cli/session-commands.mjs`, `server/api/routes.mjs`), `ARCHITECTURE-SPINE.md`, and `spec-6-4-reconnect-recovery-takeover.md`.
  - Executed `node --test tests/session-replacement.test.mjs` (11/11 pass) and verified by code inspection that `isSuperseded`, malformed `replace_existing`, and `PATCH /api/session` with `replace_existing` are not exercised by those 11 tests.
  - Executed `node scripts/rel1-verify-evidence.mjs --dir docs/release-evidence/v0.2.0-rel1` (16/16 pass) and inspected all 12 files in `docs/release-evidence/v0.2.0-rel1/` (`VERIFICATION.md`, `freshness.json`, `viewer-state.json`, `viewer-session.md`, `viewer-live.png`, `server.log`, `transcript-claude.txt`, `transcript-zcode.txt`, `preflight-claude.json`, `preflight-zcode.json`, `candidate.json`, and metadata of `recording.webm`).
- **Could NOT be verified (and why):**
  - **The formal 8-hour soak (Story 6.2) on `6d6b45f`:** In flight on `ngs-staging` (server PID `1017734`, launched `2026-10-21T11:29:25Z`); per instructions, not judged and not treated as a defect.
  - **Frame-by-frame video playback of `docs/release-evidence/v0.2.0-rel1/recording.webm` (5,261,031 bytes):** Verified file presence, size, and companion DOM snapshot (`viewer-live.png` + `viewer-state.json`), but did not decode the WebM video stream frame-by-frame.
  - **Live network reachability of `https://43.229.78.103:18444` and `ngs-staging`:** Per instructions, judged the captured evidence bundle rather than re-running or probing the remote hosts.

TEAM_DONE epic-6-release-gate-agy
