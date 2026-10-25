# BMAD Party-Mode Round-Table — Shaping Epic 7: "The Session Authority, Hardened" (v0.3)

- **Task ID:** `epic-7-shape-agy`
- **Lane:** `agy` (Antigravity / Gemini)
- **Target Commit Reviewed:** `8a13348` (`docs/epics.md:628-698`, `docs/implementation/sprint-status.yaml:89-95`) following `v0.2.0` (`95b1fa3` / candidate `3929cc7`)
- **Date:** 2026-10-26
- **Mode:** Read-Only Architecture & Scope Round-Table (5 Voices)

---

## Cast of Voices

- 📋 **John (Product Manager & Ledger Custodian):** Guards scope parity against the Epic 6 retrospective ledger (`A1–A13`), protects the v0.3 release from unbounded design creep, and insists every story have a falsifiable exit gate.
- 🏗️ **Winston (Systems & Concurrency Architect):** Owns the async execution model in `server/api/pipeline.mjs`, the dual-registry state machine (`server/api/session.mjs` + `server/core/session-registry.mjs`), and V8 heap retention mechanics.
- 🔒 **Vex (Security & Session-Authority Reviewer):** Hunts TOCTOU windows, capability leaks across Actor boundaries, bearer-token hazards, and resource-exhaustion vectors in the handoff fence and conflict-ticket protocol.
- 🎨 **Sally (Operator & Client UX Designer):** Owns the human-in-the-loop CLI flow (`agent-room session replace` in `server/cli/session-commands.mjs`), MCP client lifecycle ergonomics, and the truthfulness of shipped comments/docs (`A1`).
- 😤 **Grumbal (Adversarial Gatekeeper):** Assumes every draft mechanism has a hole until traced line-by-line against the shipped code, opposes speculative abstractions, and refuses any story order or AC wording that invites a vacuous pass.

---

## Question 1: Epic Shape — Are the six stories (7.1–7.6) the right scope split of the recorded ledger? Anything missing? Anything overreaching?

### Round-Table Exchange

📋 **John:** Let's start with ledger accounting against `docs/implementation/epic-6-retro-2026-10-21.md:251-266`, `docs/implementation/reviews/epic-6-release-gate-2026-10-25-resolution.md:49-118`, and `docs/implementation/epic-6-completion-audit.md:24-29`:
- **`A1` (Packaged docs land WITH the story before candidate freeze):** Promoted to Epic 7's standing header rule (`docs/epics.md:630`).
- **`A5` + `A7` + the two shipped `server/api/session.mjs` comments:** Grouped into **Story 7.1 (The Fence Never Lies)**.
- **`A6` (Observed incumbent conflict ticket + spine amendment):** Isolated in **Story 7.2 (The Observed Incumbent)**.
- **`A8` + `A9` (Signal-safe MCP teardown + shutdown-during-initial-bind race):** Grouped into **Story 7.3 (Always Let Go)**.
- **`A2` (Automatic unattended crash recovery design):** Isolated as a design gate in **Story 7.4 (The Automatic Recovery Design)**.
- **`A4` + `A10` (Flight Kit freshness observer + recomputing evidence verifier):** Grouped into **Story 7.5 (Instruments That Recompute)**.
- **`A11` + Attempt 6's `retainedState: rising (0.65%/hour)` diagnostic:** Isolated in **Story 7.6 (Where the Heap Goes)**.
Meanwhile, `A3` (`COPYFILE_DISABLE=1` in the runbook tar recipe) and `A12`/`A13` (measured quiet-host contract + `scripts/rel3-soak-eligibility.mjs` scorer with 30 fixtures) were already closed during the v0.2.0 Attempt 6 gate. As a partition of the v0.3 ledger into six stories, the coupling boundaries are clean: 7.1 is in-process pipeline/fence state, 7.2 is a wire/spine protocol change, 7.3 is client/MCP process lifecycle, 7.4 is a design gate, 7.5 is offline release tooling, and 7.6 is heap profiling and threshold calibration.

🎨 **Sally:** The six-story split is right, John, but **Story 7.1's comment-correction scope is incomplete** and will create the exact inverse of the v0.2.0 doc bug if we don't fix the AC now! Look at `docs/epics.md:642`: Story 7.1 names *only* the two false comments in `server/api/session.mjs:60-67` and `149-150` (from `epic-6-release-gate-2026-10-25-resolution.md:50-56`). Why were only those two left behind in v0.2.0? Because the third re-cut (`3929cc7`) edited four *other* packaged files plus the Spine to narrate the old A5 window:
1. `server/api/pipeline.mjs:424-434` (*"On a route that carries a body, the authorization stage runs before `readRequestFields` awaits the body stream..."*)
2. `server/api/server.mjs:495-500, 596-600` (*"It does NOT cancel an already-admitted request that is already past the authorization stage (for example, one still streaming its request body)..."*)
3. `server/cli/session-commands.mjs:23-29` (*"a request that was already past the authorization stage when the takeover ran can still finish reading its body and reach its handler"*)
4. `README.md`, `CHANGELOG.md`, and `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:124`.
Once Story 7.1 closes A5, all four of those locations become **false in the opposite direction** (claiming a hole still exists when it has been closed)! And while we are touching `README.md` under rule `A1`, we must also delete the Epic 1 fossil at `README.md:197` (*"The read-only web viewer is not part of the v0.2 tool surface yet (Epic 5)"*) that `epic-6-release-gate-2026-10-25-agy.md:83` flagged and held back only because of the Candidate Immutability Law.

🔒 **Vex:** I'll add a second missing seam in Story 7.1, and a missing security boundary in Story 7.2:
1. **In Story 7.1 (Long-Poll wakeups after supersession):** In `epic-6-release-gate-agy.md:73, 218`, we noted that `readMessages` (`server/api/server.mjs:847-875`) holds `GET /api/rooms/:id/messages?wait_ms=20000` inside `handler(context)` for up to 20 seconds. On every poll wakeup (`line 852`), it re-checks `if (store.isActorBanned(principal.actorFingerprint)) return reject('banned')`, **but it never checks `if (effectiveSessionRegistry.isSuperseded(principal.sessionKey)) return reject('unauthorized')`!** A displaced session whose long-poll was already inside `readMessages` continues receiving room messages that arrive *after* its displacement.
2. **In Story 7.2 (Same-Actor gating on the conflict ticket):** Story 7.2 (`docs/epics.md:651`) says *"the conflict response (`409 chat_id_taken`) or a dedicated preflight surfaces an opaque, server-issued ticket bound to `{ actorFingerprint, normalizedChatId, observedIncumbentSessionKey }`."* Wait: if a **different Actor** (`actorFingerprintB`) collides with `actorFingerprintA`'s `"Agent"` and receives `409 chat_id_taken`, the server MUST NOT mint or return a conflict ticket to `actorFingerprintB`! Returning a ticket only when `holder.actorFingerprint === principal.actorFingerprint` (or requiring a same-Actor authenticated preflight) must be explicit in 7.2's AC so we don't leak incumbent rotation state to foreign Actors.

📋 **John:** Hold on, Vex — on the Long-Poll wakeup check, A5 in the retro ledger (`epic-6-retro-2026-10-21.md:258`) explicitly says *"after the LAST awaited input step, directly before the mutation."* `GET /api/rooms/:id/messages` is a read, not a mutation, and the Actor itself is not banned — another session of the *same* Actor took the Chat ID.

🏗️ **Winston:** John, Vex is right to want `isSuperseded` at `server/api/server.mjs:852` for a mechanical reason, not just a security one: if Story 7.1 uses in-flight counting across `runPipeline`, a 20-second long-poll stays inside `runPipeline` for up to 20 seconds. Adding `if (effectiveSessionRegistry.isSuperseded(principal.sessionKey)) return reject('unauthorized')` right next to `isActorBanned` at `server.mjs:852` is **one line of code** and ensures a displaced session stops draining messages after handoff.

😤 **Grumbal:** Also note two ledger housekeeping bugs in `docs/implementation/sprint-status.yaml` (not in `docs/epics.md`, which is clean):
1. `sprint-status.yaml:321-327` (`epic-6-retro-item-a3`) corrupted `A3` (`COPYFILE_DISABLE=1`) into a duplicate of Epic 5's cookie-lifetime item, and `A11` is missing from `action_items:` in `sprint-status.yaml` even though `A12` and `A13` are still marked `status: open` (`lines 336-356`) despite being closed before Attempt 6.
2. Look at `sprint-status.yaml:73-74`: Stories `4-7` and `4-8` still say `backlog` in `sprint-status.yaml` even though Epic 4 is audited and done. None of that changes Epic 7's stories, but the orchestrator should clean up `sprint-status.yaml` when recording Epic 7.

### Ruling on Question 1 (Epic Shape)
- **The 6-story split (`7.1–7.6`) is the RIGHT structural decomposition of the recorded v0.3 ledger.** Nothing in 7.1–7.6 overreaches what the Epic 6 retro, completion audit, and release-gate resolution assigned to v0.3.
- **Three concrete amendments to Story 7.1 and 7.2 ACs are required so nothing committed is missed:**
  1. **Story 7.1 AC (Comment & Doc Sweep):** Expand the comment-correction AC from only `server/api/session.mjs:60-67, 149-150` to also update the four locations where the third re-cut (`3929cc7`) documented the old A5 window (`server/api/pipeline.mjs:424-434`, `server/api/server.mjs:495-500, 596-600`, `server/cli/session-commands.mjs:23-29`, and `ARCHITECTURE-SPINE.md:124` / `README.md` / `CHANGELOG.md`), plus remove the stale Epic 1 viewer sentence at `README.md:197`.
  2. **Story 7.1 AC (Long-Poll Wakeup Parity — disputed between John and Vex/Winston; see clash):** Vex, Winston, and Grumbal recommend adding the 1-line `effectiveSessionRegistry.isSuperseded(principal.sessionKey)` check alongside `store.isActorBanned` in the `readMessages` poll wakeup loop (`server/api/server.mjs:852`); John considers it optional polish beyond A5's "before the mutation" wording.
  3. **Story 7.2 AC (Same-Actor Ticket Confidentiality):** Explicitly state that `409 chat_id_taken` (or the preflight) only issues/surfaces `conflict_ticket` when `holder.actorFingerprint === principal.actorFingerprint`; foreign-Actor collisions receive a bare `409 chat_id_taken` with no ticket and no incumbent metadata.

---

## Question 2: Story Order — 7.1–7.3 before 7.4, or Design-First? Would A2 reshape 7.1–7.3?

### Round-Table Exchange (Unresolved Clash on `7.2` vs `7.4`)

🏗️ **Winston:** Let's separate `7.1`, `7.2`, and `7.3` instead of treating `7.1–7.3` as a monolith!
- **Can `7.4` (A2 automatic recovery design) reshape `7.1` (A5 + A7 fence hardening)? NO.** Whether a handoff is triggered by an operator (`session replace`) or by an automatic successor mechanism, the server still displaces an old `sessionKey` and must fence in-flight requests after `readRequestFields` (`A5`) without evicting the fence entry (`A7`). `7.1` is 100% invariant.
- **Can `7.4` reshape `7.3` (A8 + A9 signal-safe MCP teardown & shutdown-during-bind race)? NO — in fact, `7.3` MUST run before `7.4`!** Think about what happened in REL-1 (`epic-6-retro-2026-10-21.md:107-125`): `ZCODE-MAC-2` stayed squatted three times in a row after `zcode -p` exited cleanly because `server/mcp-stdio.mjs:755` only listened to `input.once('close')` and ignored `SIGTERM`/`SIGINT` (`A8`). Once `7.3` lands, **every normal CLI termination (`SIGTERM`, `SIGINT`, EOF, and shutdown-during-initial-bind) releases the Chat ID immediately**. The remaining real-world scenarios that even *need* `A2` shrink to `SIGKILL` (`kill -9`), OOM-kill, power loss, or a dead remote TCP peer. You cannot rationally weigh the cost/benefit of `7.4` until `7.3` has eliminated the polite-kill squats!
- **Can `7.4` reshape `7.2` (A6 observed incumbent conflict ticket)? YES!** Look at the code: `7.2` amends `ARCHITECTURE-SPINE.md`, changes the `POST /api/session` wire payload and `409 chat_id_taken` error shape in `server/api/server.mjs:505-616`, and changes `liveSessionRegistry.transfer` in `server/core/session-registry.mjs:313-392`. If `7.4` runs *after* `7.2` and decides to add an automatic recovery proof to `POST /api/session` (for instance, a predecessor-bound lease/ratchet ticket), **we would be redesigning and amending `POST /api/session`, `liveSessionRegistry.transfer`, and `ARCHITECTURE-SPINE.md` TWICE in the same epic!** Therefore, the right order is: **`7.1` → `7.3` → `7.4` (Design Gate) → `7.2`** (with `7.5` and `7.6` runnable in parallel at any point).

🎨 **Sally:** I strongly back Winston on running **`7.4` before `7.2`**, and here is the client/CLI reason why: look at `server/cli/session-commands.mjs:147-180` (`runSessionReplace`). Today, `agent-room session replace` does **not** observe an incumbent before prompting the operator `[y/N]` — it prompts first, then blindly sends `POST /api/session` with `{ chat_id, replace_existing: true }`, and then sends `DELETE /api/session`. Under Story 7.2 (`A6`), `session replace` has to obtain an opaque `conflict_ticket` bound to the *observed* incumbent *before* (or during) the operator's confirmation flow. If `7.4` also introduces a local recovery state file in `${PLUGIN_DATA}` or alters what `POST /api/session` returns on `409 chat_id_taken`, designing `7.4` and `7.2`'s `POST /api/session` state machine together prevents churning the CLI and `api-client.mjs` twice.

📋 **John:** I disagree with delaying `7.2` behind `7.4`, Winston and Sally. Look at the retro ledger: `A6` (`7.2`) is a **committed correctness fix** on the existing operator takeover path (`agent-room session replace`) with an executed reproduction (`epic-6-release-gate-codex.md:116`). Even if `7.4` invents a miracle automatic crash recovery mechanism for same-machine restarts, **manual operator takeover (`agent-room session replace`) can never go away** — you still need it when a remote container's disk is wiped, when a process is wedged (`SIGSTOP`) rather than dead, or when the operator deliberately evicts a runaway session. And let's be honest: `7.4` has a very high probability of concluding that *no* unattended mechanism satisfies the security invariants without weakening explicit takeover (a documented refusal). Holding up a concrete protocol fix (`7.2`) behind a philosophical design round-table (`7.4`) violates our bias toward shipping verified fixes first.

😤 **Grumbal:** John is right about the risk of design paralysis, and Winston is right that `7.3` must precede `7.4`. But notice why Winston and John are clashing on `7.2` vs `7.4`: `7.4` is ONLY a paper round-table story (`docs/epics.md:668-676`), not an implementation story! Why would a 1-session design round-table block anything? Whether you run **`7.1 → 7.3 → 7.4 → 7.2`** (Winston/Sally) or **`7.1 → 7.2 → 7.3 → 7.4`** (John), **nobody disputes that `7.1` and `7.3` cannot be invalidated by `7.4` and belong before `7.4`**. And even if `7.4` approves a follow-on story (say `7.7`), automatic recovery and manual operator takeover (`7.2`) are orthogonal branches in `POST /api/session`: one presents an unattended predecessor-death proof, while the other presents an interactive operator `conflict_ticket`.

### Ruling on Question 2 (Story Order)
- **Consensus on `7.1` and `7.3`:** Neither **Story 7.1 (`A5` + `A7`)** nor **Story 7.3 (`A8` + `A9`)** can be invalidated or forced into rework by `7.4` (`A2`). Both should execute **before `7.4`** — and in particular, **Story 7.3 (`A8` signal-safe teardown) should land before `7.4` evaluates `A2`**, because `7.3` eliminates the polite-exit CLI squats (`zcode -p`) that motivated the crash-recovery discussion in REL-1.
- **Unresolved Disagreement on `7.2` vs `7.4`:**
  - **Winston & Sally's Order (`7.1 → 7.3 → 7.4 → 7.2`, with `7.5` & `7.6` independent):** Run the `7.4` design round-table *before* coding `7.2` so that `POST /api/session`, `liveSessionRegistry.transfer`, and `ARCHITECTURE-SPINE.md` are amended once with full visibility of both operator conflict tickets (`A6`) and any automatic recovery proof (`A2`).
  - **John & Grumbal's Order (`7.1 → 7.2 → 7.3 → 7.4` as authored):** Keep `7.1–7.3` before `7.4`. `7.2` fixes a proven race on the mandatory operator takeover path (`agent-room session replace`), which remains necessary regardless of `7.4`'s outcome, and `7.2`'s opaque `conflict_ticket` on `409 chat_id_taken` is orthogonal to any unattended successor credential.

---

## Question 3: A7 Mechanism — Is Story 7.1's draft IN-FLIGHT COUNTING mechanism correct and complete?

### Round-Table Exchange

😤 **Grumbal:** **REFUSE the draft mechanism as written.** Not because in-flight counting is the wrong family — time-based retention and never-drop are both worse — but because Story 7.1's draft formulation in the prompt and `docs/epics.md:639-641` contains **three concrete bugs** that will either leave A7 exploitable or break existing unit tests if implemented literally:

1. **Bug 1 — The "old count bound stays as a backstop" contradiction:**
   The draft says: *"a superseded session's fence entry may be dropped only when no request can still be in flight with that key (a displaced token cannot authenticate, so the count only falls); the old count bound stays as a backstop."*
   Wait: what happens if 1,001 requests are simultaneously in flight (e.g., 1,001 slow-streaming POSTs or 20-second long-polls — or 2 in-flight requests in a test with `maxSessions: 1`), and all 1,001 sessions are superseded while still in flight?
   - If *"the old count bound (`maxSessions`) stays as a backstop"* means `superseded` still drops the oldest entry at `maxSessions` when all entries have `inFlightCount > 0`, **then the fence is STILL exhaustible and A7 is NOT fixed!**
   - Conversely, if an entry with `inFlightCount > 0` can **never** be dropped, then `maxSessions` is NOT a backstop on active (`inFlightCount > 0`) fence entries — `maxSessions` may **only** bound **idle tombstones (`inFlightCount === 0`)**!

2. **Bug 2 — Where "admission" happens in `runPipeline` (The `BudgetStage` async trap):**
   Look at `server/api/pipeline.mjs:356` and `609-620`:
   ```js
   // pipeline.mjs:356 inside BudgetStage.process(context)
   const readOutcome = await readRequestFields(context)
   ```
   On `POST /api/rooms/:id/messages`, `readRequestFields(context)` is `await`ed **INSIDE `BudgetStage.process(context)` (Stage 4), BEFORE `AuthzStage` (Stage 5) and BEFORE line 618!**
   If a developer implements "register `sessionKey` as in-flight at admission" at `AuthzStage` or after the `for (const stage of stages)` loop in `runPipeline`, any `POST /api/rooms/:id/messages` request streaming its body inside `BudgetStage` has **already passed `AuthStage` (`registry.verify(token)`)** with `inFlightCount === 0`! If it gets superseded and evicted while paused at `pipeline.mjs:356`, it slips right past the fence!
   Therefore, in-flight registration **MUST occur immediately when `AuthStage` (`stage.name === 'auth'`) completes inside `runPipeline`** (as soon as `context.session?.sessionKey` exists), and unregistration **MUST be in a `try { ... } finally { ... }` wrapping all subsequent stages (`budgets`, `authz`), `readRequestFields`, the post-input revalidation, and `handler(context)`**!

3. **Bug 3 — The Standalone `AuthStage` / `AuthzStage` Unit-Test Trap:**
   In `tests/api-host.test.mjs` and `tests/session-replacement.test.mjs:493-525` (plus the release-gate reproduction at `epic-6-release-gate-codex.md:129`), tests invoke `new AuthStage().process(context)` or `new AuthzStage().process(context)` directly **without calling `runPipeline`**.
   - If `AuthStage.process()` increments `inFlightCount` directly instead of `runPipeline` bracketing it with `try / finally`, every standalone `new AuthStage().process()` call in the test suite permanently leaks `inFlightCount >= 1`!
   - Conversely, look at `epic-6-release-gate-codex.md:129`:
     ```js
     const cap = createSessionRegistry({ maxSessions: 1 });
     const key = sessionKeyFromToken(cap.issue(actor));
     cap.supersede(key);
     cap.supersede('later-key');
     const admitted = { route: { class: 'actor' }, session: { sessionKey: key, actorFingerprint: actor }, sessionRegistry: cap };
     assert.equal(cap.isSuperseded(key), false);
     assert.equal(new AuthzStage().process(admitted), undefined);
     ```
     Notice why that synthetic probe in `codex.md` was able to bypass `AuthzStage` without `runPipeline`: `key` was issued by `cap.issue(actor)`, deleted from `sessions` by `cap.supersede(key)`, and then `cap.supersede('later-key')` evicted `key` from `superseded` because `inFlightCount(key)` was `0`!

🏗️ **Winston:** Look at Grumbal's Bug 3 closely, everyone, because it exposes a deeper architectural truth about `server/api/session.mjs`!
Ask yourselves: **Why did Story 6.4 need a negative tombstone set (`superseded = new Map()`) in `createSessionRegistry` in the first place, instead of checking positive membership in `sessions` (`sessionRegistry.isLive(sessionKey)`)?**
Let's trace `server/api/session.mjs:59-153`:
- When `issue(actorFingerprint)` mints a token, its `sessionKey` (`digest`) is stored in `const sessions = new Map()`.
- When `verify(token)` runs in `AuthStage`, it succeeds **only** if `sessions.has(sessionKey)` is `true` (and not expired).
- When `supersede(sessionKey)` runs (`line 138`), its very first statement is:
  `const removed = sessions.delete(sessionKey)`!
- Once `sessions.delete(sessionKey)` has executed, **`sessions.has(sessionKey)` is `false` forever**! No amount of subsequent `issue()` or `supersede()` calls (whether 1,001 or 10,000,000) will ever put that SHA-256 digest back into `sessions`!
- So why couldn't `AuthzStage` simply check `!sessionRegistry.isLive(sessionKey)`? **Only because** a handful of unit tests (`tests/session-replacement.test.mjs:518` and custom `sessionVerifier` stubs in `tests/api-host.test.mjs`) pass synthetic `sessionKey` strings (like `'another-key'`) into `AuthzStage` without ever calling `sessionRegistry.issue()`!

🔒 **Vex:** Wait — Winston, follow that through! What if `createSessionRegistry` does **both** (or what if we compare pure In-Flight-Pinned Tombstones against Positive Liveness + In-Flight Pinning)?
Look at what happens if:
1. Whenever `AuthStage` verifies a token through `createSessionVerifier(sessionRegistry)` (`server/api/session.mjs:205-215`), it marks `session.registryVerified = true` (or `sessionRegistry` tracks `inFlight` via `enterInFlight(sessionKey)` / `leaveInFlight(sessionKey)` in `runPipeline`).
2. For any session with `session.registryVerified === true`, the authority check (`isSuperseded` / `isDisplaced`) is satisfied if `superseded.has(sessionKey) || !sessionRegistry.isLive(sessionKey)`!
   - Wait: if we check `!sessionRegistry.isLive(sessionKey)` on registry-verified sessions, what happens if a session is evicted from `sessions` by LRU (`SESSIONS_MAX = 1000`) or `revoke(sessionKey)` (`DELETE /api/session`) while another request on that same session is mid-body? It is ALSO refused immediately before mutation — which is strictly stronger session-authority enforcement!
   - AND for synthetic unit tests that call `sessionRegistry.supersede(key)` directly without `verify(token)` (`tests/session-replacement.test.mjs:493-525`), `superseded` retains entries with **`inFlightCount(key) > 0` pinned (never evictable)** and bounds only **`inFlightCount(key) === 0` idle tombstones** at `maxSessions`!

📋 **John:** Let's also rule explicitly on the two alternatives the prompt asked us to evaluate:
- **Why Time-Based Retention (`retain ≥ max request lifetime`) is REFUSED:**
  1. In `server/api/pipeline.mjs:465-505` (`readBodyStream`), there is no pipeline-enforced wall-clock timer on reading the request body stream, and on `GET /api/rooms/:id/messages?wait_ms=20000` a request lives 20+ seconds. Any fixed TTL is a guess that can be outlasted by a slow drip over a socket unless coupled with hard socket timeouts.
  2. Our deterministic unit tests (`tests/session-replacement.test.mjs`, `tests/api-host.test.mjs`) inject synthetic clocks (`now: () => clock`) that do not advance during async stream microtasks unless manually ticked, making time-based fence retention brittle and non-deterministic.
- **Why Never-Drop (`unbounded Map/Set`) is REFUSED:**
  1. Every supersession adds a 64-character hex SHA-256 string (`sessionKey`) to `superseded`. Under automated connection/takeover churn over a 12-hour soak (`REL-3`), an unbounded `superseded` Set is a monotonic V8 heap retainer — directly worsening the `retainedState: rising` finding that Story 7.6 is trying to close!

### Ruling on Question 3 (A7 Mechanism)
- **Verdict:** **REFUSE Story 7.1's draft in-flight counting wording as currently stated; APPROVE the corrected In-Flight Pinning + Positive-Liveness specification below.** Time-based retention and never-drop are both **refused**.
- **What the corrected Story 7.1 mechanism MUST specify:**
  1. **Admission & Completion Bracketing in `runPipeline` (`server/api/pipeline.mjs`):**
     - `sessionRegistry` exposes `enterInFlight(sessionKey)` and `leaveInFlight(sessionKey)` (or `inFlightCount(sessionKey)`).
     - Inside `runPipeline(stages, context, handler)`, immediately when `stage.name === 'auth'` succeeds and `context.session?.sessionKey` is populated — **before `BudgetStage` runs** (because `BudgetStage` awaits `readRequestFields` at `pipeline.mjs:356`!) — call `context.sessionRegistry?.enterInFlight?.(context.session.sessionKey)` and wrap the entire remainder of `runPipeline` (remaining stages, `readRequestFields`, post-input revalidation, and `handler(context)`) in a `try { ... } finally { context.sessionRegistry?.leaveInFlight?.(trackedKey) }` block.
     - Do **not** increment the counter inside `AuthStage.process()` directly, so standalone `new AuthStage().process()` unit tests cannot leak counts.
  2. **The Eviction Rule in `createSessionRegistry` (`server/api/session.mjs`):**
     - Replace the ambiguous *"the old count bound stays as a backstop"* with the exact invariant: **An entry in `superseded` with `inFlightCount(key) > 0` is PINNED and may NEVER be evicted under any circumstance.**
     - `maxSessions` (1,000) bounds **only idle tombstones (`inFlightCount(key) === 0`)**: when `superseded.size > maxSessions`, the eviction scan skips any key with `inFlightCount(key) > 0` and evicts only the oldest key(s) where `inFlightCount(key) === 0`. When `leaveInFlight(key)` drops a superseded key's count to `0` and `superseded.size > maxSessions`, excess `inFlightCount === 0` keys are pruned then.
  3. **Disagreement between Winston/Vex and John on Positive Liveness (`!isLive`):**
     - **Winston & Vex** recommend that for tokens verified by `createSessionVerifier(sessionRegistry)`, the authority check should also refuse if `!sessionRegistry.isLive(sessionKey)` (which requires zero tombstones and cannot be exhausted even in synthetic non-pipeline tests like `epic-6-release-gate-codex.md:129` when `key` was issued by `cap.issue()`).
     - **John & Grumbal** note that if `epic-6-release-gate-codex.md:129`'s synthetic test is updated (or if `enterInFlight` is called on `verify()`), in-flight pinning on `superseded` alone closes A7 without changing how `revoke()` or `SESSIONS_MAX` LRU eviction interacts with in-flight requests.

---

## Question 4: A5 Placement — Post-input revalidation in `runPipeline` after `readRequestFields` and directly before `handler(context)`. Is that complete? Should the BAN check also re-run there?

### Round-Table Exchange (Unresolved Clash on Re-Running the Ban Check)

🏗️ **Winston:** Let's trace the exact control flow of `runPipeline` in `server/api/pipeline.mjs:609-634` and every handler in `server/api/server.mjs:1192-1456`:
```js
export async function runPipeline(stages, context, handler) {
  assertStageOrder(stages)
  for (const stage of stages) {
    const outcome = await stage.process(context)
    if (outcome !== undefined && outcome !== null) {
      if (outcome.refusal === true) return outcome
      if (isRejection(outcome)) return ensureStatus(outcome)
    }
  }
  const fieldsOutcome = await readRequestFields(context)
  if (fieldsOutcome) return fieldsOutcome
  // <--- PROPOSED A5 PLACEMENT HERE
  try {
    const value = await handler(context)
```
Let's check whether ANY `await` exists after `readRequestFields(context)` and before the state mutation inside `handler(context)` across every `actor`-class route in `server/api/server.mjs`:
1. `POST /api/session` (`bindSession`, `server.mjs:505-616`): **100% synchronous.**
2. `PATCH /api/session` (`renameSessionRoute`, `server.mjs:625-657`): **100% synchronous.**
3. `DELETE /api/session` (`releaseSessionRoute`, `server.mjs:659-670`): **100% synchronous.**
4. `POST /api/rooms` (`createRoomRoute`, `server.mjs:698-725`): **100% synchronous.**
5. `POST /api/rooms/direct` (`openDirectRoomRoute`, `server.mjs:727-769`): **100% synchronous.**
6. `POST /api/rooms/:id/join` (`joinRoomRoute`, `server.mjs:771-801`): **100% synchronous.**
7. `POST /api/rooms/:id/messages` (`appendMessageRoute`, `server.mjs:884-995`): **100% synchronous.** (And its body was already read in `BudgetStage` at `pipeline.mjs:356`, so `readRequestFields` at `line 618` is a synchronous no-op).
8. `POST /api/held/:id/release` (`releaseHeldMessageRoute`, `server.mjs:1029-1052`): **100% synchronous.**

Because Node.js is single-threaded across synchronous turns, placing the revalidation **immediately after `const fieldsOutcome = await readRequestFields(context); if (fieldsOutcome) return fieldsOutcome` and directly before `const value = await handler(context)` leaves ZERO `await` suspension points before every mutation in the server.** No takeover handoff can interleave between that check and the handler's commit!

😤 **Grumbal:** Two implementation guardrails on that placement in `server/api/pipeline.mjs`:
1. **Guardrail 1 (Partial stage lists in unit tests):** In `tests/api-host.test.mjs`, several unit tests call `runPipeline([new ProtocolStage()], context, handler)` without an `AuthzStage` in `stages`. Therefore, `runPipeline` must only execute the post-input revalidation when `stages` includes an `authz` stage (or by calling a method on the `authz` stage found in `stages`) AND `context.route?.class === 'actor'`.
2. **Guardrail 2 (Why `AuthzStage` MUST ALSO stay in its stage slot before `readRequestFields`):** Nobody should be tempted to *move* `AuthzStage` after `readRequestFields` instead of *re-running* it! Why? Because per AD-7 (`protocol -> transport -> auth -> budgets -> authz`), a session that is *already* superseded or banned when the request headers arrive must be rejected at `AuthzStage` **before** the server wastes memory and bandwidth reading a 64 KiB–1 MiB request body stream in `readRequestFields(context)`! Furthermore, on `POST /api/rooms/:id/messages`, `BudgetStage` (`pipeline.mjs:356`) already sets `context.requestFieldsRead = true` *before* `AuthzStage` runs — so if you keep track of whether `readRequestFields` at `line 618` actually awaited the stream (i.e. `const wasAlreadyRead = context.requestFieldsRead === true` before `line 618`), you only even *need* the post-input re-check when `!wasAlreadyRead` (though running an in-memory `isSuperseded` check unconditionally after `line 618` costs nanoseconds).

🔒 **Vex:** Now let's fight over the second half of Question 4: **Should the BAN check (`store.isActorBanned`) also re-run after `readRequestFields`, or only `sessionRegistry.isSuperseded(sessionKey)`?**
I say: **Re-run BOTH (i.e. re-invoke `authzStage.process(context)` after `readRequestFields` whenever `!wasAlreadyRead`)!**
Look at `AuthzStage.process(context)` (`server/api/pipeline.mjs:416-452`): it is 15 lines of synchronous code checking `isSuperseded` (`401 unauthorized`) and `store.isActorBanned` (`403 banned`). Suppose an Actor starts slow-streaming the body of `POST /api/rooms/direct` or `POST /api/rooms` or `POST /api/session`, and while the body is in flight, the operator runs `agent-room ban <fingerprint>`. Why on earth should a banned Actor be allowed to create a room or bind a session *after* the ban was committed to SQLite, when calling `authzStage.process(context)` after `readRequestFields` closes both the takeover window and the slow-body ban window in a single call? And notice: on the hot path (`POST /api/rooms/:id/messages`), `BudgetStage` already read the body before `AuthzStage`, so if you only re-run `authzStage.process(context)` when `readRequestFields` at `line 618` actually ran (`!wasAlreadyRead`), **the message-send hot path pays ZERO extra SQLite queries!**

📋 **John:** I oppose re-running `store.isActorBanned` there, Vex — **that IS scope creep, and it conflicts with a prior recorded decision (`FR-15` / Story 4.5)!**
Look at `docs/epics.md:61` (FR-15) and `HANDOFF.md:220` (`DECIDED — DO NOT RELITIGATE`):
- *"Ban ships WITHOUT session revocation — the ban holds at the resource boundary."*
- *"In-flight requests refused at next request; enforcement latency for an active Long-Poll bounded by the 20s hold window."*
Unlike Story 6.4 (where the spec and comments explicitly promised that an already-admitted request could not land after a takeover, creating A5 when that promise proved false), **FR-15 explicitly contracted that an already-admitted in-flight request is refused "at next request"!**
And look at the retro ledger (`epic-6-retro-2026-10-21.md:258`, `docs/epics.md:638`): A5 says *"Revalidate the session authority after the LAST awaited input step, directly before the mutation."* In our terminology (including the title of Epic 7 itself: *"The Session Authority, Hardened"*), "the session authority" is the session-ownership fence (`sessionRegistry.isSuperseded(sessionKey)`), NOT the realm ban table (`store.isActorBanned`).

🏗️ **Winston:** I side with **John** on keeping the post-input check strictly to `sessionRegistry.isSuperseded(sessionKey)` (the handoff fence), for two reasons:
1. `sessionRegistry.isSuperseded(sessionKey)` is a pure in-memory `Map.has()` lookup with zero SQLite I/O and zero dependency on `context.store`.
2. Re-running `store.isActorBanned` alters FR-15's "at next request" semantics without an epic item or retro finding asking for it.
However, as I agreed with Vex under Question 1, I **would** add the 1-line `effectiveSessionRegistry.isSuperseded(principal.sessionKey)` check inside `readMessages` (`server/api/server.mjs:852`) on Long-Poll wakeups, because Long-Poll awaits *inside* `handler(context)` after `runPipeline`'s post-input check has already passed.

### Ruling on Question 4 (A5 Placement & Ban Check)
- **Placement Verdict:** **YES — immediately after `const fieldsOutcome = await readRequestFields(context); if (fieldsOutcome) return fieldsOutcome` and directly before `const value = await handler(context)` in `server/api/pipeline.mjs:618-621` is the exact, complete placement for all mutating routes.** Every mutating handler in `server/api/server.mjs` is 100% synchronous from entry to store/registry commit, leaving zero `await` points after that check.
- **Required Guardrails on Placement:**
  1. Keep `AuthzStage` in its existing stage-5 slot *as well* so already-superseded/banned requests are rejected before reading body streams (`AD-7`).
  2. In `runPipeline`, gate the post-input fence check on `context.route?.class === 'actor'` and the presence of `authz` in `stages` so partial-pipeline unit tests (`tests/api-host.test.mjs`) are unaffected.
  3. Update `tests/session-replacement.test.mjs:527-598` (`KNOWN GAP (v0.3 backlog)`) from asserting `200` to asserting `401 unauthorized` and verifying that the delayed body does not execute `handler`.
- **Unresolved Disagreement on Re-Running the Ban Check (`store.isActorBanned`):**
  - **John & Winston (Majority — Fence Only):** Re-run **only** the handoff-fence check (`sessionRegistry.isSuperseded(sessionKey)`). Re-running `store.isActorBanned` is unrequested scope creep that contradicts FR-15's explicit *"in-flight requests refused at next request"* contract and adds SQLite I/O outside `AuthzStage`.
  - **Vex & Grumbal (Minority — Re-run full `AuthzStage` when `!wasAlreadyRead`):** Since `BudgetStage` already reads the body before `AuthzStage` on `POST /api/rooms/:id/messages`, re-running `authzStage.process(context)` after `line 618` only when `readRequestFields` actually awaited a stream (`!wasAlreadyRead`) costs zero extra SQLite queries on the message hot path while preventing slow-streamed `POST /api/rooms` or `POST /api/session` mutations from landing after an operator ban.

---

## Question 5: A2 Direction — Ownership evidence for a rightful successor process vs explicit-decision takeover. Candidates, failure modes, or pre-commit to nothing?

### Round-Table Exchange (Unresolved Clash on Candidate 2 vs Pre-Committing to Nothing)

🔒 **Vex:** Let's state the fundamental impossibility theorem of A2 first so nobody waves their hands:
When Process 1 (`PID 1001`) and Process 2 (`PID 1002`) run on the same installation, **both read the exact same `${PLUGIN_DATA}` directory** (`keypair.json`, `config.json`) and authenticate as the **exact same `actorFingerprint`**.
If Process 2 starts up and finds `"Agent"` already held on the server by Process 1 (`409 chat_id_taken`), there are **two indistinguishable world states** from the server's perspective:
- **World A (Crash Restart):** Process 1 was killed (`SIGKILL` / OOM / host reboot) without releasing its session, and Process 2 is its legitimate restart.
- **World B (Co-Tenancy / Two Open Terminals):** Process 1 is **still alive** in Terminal Tab 1, and the user (or an automation script) opened Terminal Tab 2 pointing at the same `${PLUGIN_DATA}`!
If Process 2 automatically takes over in World B, it silently kills live Terminal Tab 1 — and if Tab 1 then auto-reconnects on `401`, **Tab 1 and Tab 2 enter an infinite ping-pong takeover war**!
Now let's test every candidate mechanism for "ownership evidence" against World A vs World B:

#### Candidate 1: Server-Issued One-Time Recovery Secret / Ratchet Stored in `${PLUGIN_DATA}` (Disk File Only)
- **Mechanism:** `POST /api/session` returns a one-time `recovery_secret` (or stores `sha256(secret)` bound to `{ actorFingerprint, chatId, incumbentSessionKey }`). Process 1 writes `recovery_secret` to `${PLUGIN_DATA}/session-recovery.json` (`0o600`). On restart, Process 2 reads and deletes the file and sends `recovery_secret` with its `POST /api/session` to atomically succeed Process 1.
- **Why it is NOT a session-resurrecting bearer token:** It cannot authenticate MCP tool calls (`AuthStage` rejects it); it only authorizes a same-Actor `POST /api/session` transition when presented alongside valid Actor authentication (`local-token` + keypair or remote challenge signature), and it ratchets (single-use).
- **Fatal Failure Mode:** **Fails World B completely!** Because Terminal Tab 1 and Terminal Tab 2 share `${PLUGIN_DATA}`, Tab 2 can read `${PLUGIN_DATA}/session-recovery.json` off disk **while Tab 1 is still alive and healthy**, silently displacing Tab 1! A file on disk proves **filesystem co-tenancy**, NOT **predecessor death**.

#### Candidate 2: Kernel-Enforced Local Liveness Gate (`node:net` Unix Domain Socket / Named Pipe in `${PLUGIN_DATA}`) + One-Time Server-Bound `recovery_ticket`
- **Mechanism (championed by Winston & Sally for evaluation):**
  - Remember our policy constraint: **Zero external runtime npm dependencies (Node 24 built-ins only).** Node 24's `node:fs` does not expose POSIX `flock(2)` / `fcntl(F_SETLK)`, **but `node:net` DOES provide Unix domain sockets (`${PLUGIN_DATA}/session.sock`, `0o600`)!**
  - When Process 1 binds `"Agent"`, it binds a local Unix domain socket at `${PLUGIN_DATA}/session.sock` (or Windows named pipe) and writes the one-time server-issued `recovery_ticket` (bound to `{ actorFingerprint, normalizedChatId, incumbentSessionKey }`) to `${PLUGIN_DATA}/session-recovery.json` (`0o600`).
  - If Process 1 dies via `SIGKILL` / OOM / crash, the OS kernel immediately closes its socket descriptor. The socket path on disk becomes a dead file that returns **`ECONNREFUSED`** on `net.connect()`.
  - When Process 2 starts and gets `409 chat_id_taken` (with `same_actor: true`):
    1. Process 2 attempts `net.connect('${PLUGIN_DATA}/session.sock')`.
    2. **If `connect` succeeds (World B — Tab 1 is alive!):** Process 2 knows with kernel certainty that Process 1 is still running on this machine. Process 2 **aborts automatic recovery immediately** and surfaces `chat_id_taken`! Zero ping-pong, zero silent eviction of a live tab!
    3. **If `connect` fails with `ECONNREFUSED` (World A — Process 1 died ungracefully!):** Process 2 unlinks the stale socket, binds its own `${PLUGIN_DATA}/session.sock`, reads the one-time `recovery_ticket`, and submits it to `POST /api/session` to atomically succeed the dead incumbent!
- **Failure Modes of Candidate 2:**
  1. **Cross-Machine / Rebuilt-Container Blind Spot:** If two machines or two containers share a copied `keypair.json` on *separate* filesystems, or if a container restart wiped `${PLUGIN_DATA}`'s runtime files while keeping a mounted `keypair.json`, `session.sock` and `session-recovery.json` are absent or local-only; automatic recovery cannot fire (falls back to `agent-room session replace`).
  2. **`SIGSTOP` / Hung Event Loop:** If Process 1 is paused via `SIGSTOP` (`Ctrl+Z`) or wedged for >5s so its socket accept queue or handshake times out, Process 2 could mistake a frozen process for a dead one (though if Process 1 later wakes via `SIGCONT`, Story 7.1's fence cleanly refuses Process 1's displaced token).
  3. **Second Local Socket Surface:** Re-introduces a local Unix domain socket into `mcp-stdio.mjs` after v0.2 retired `roomd.mjs`'s Unix socket, plus `SUN_LEN` (~104 bytes on macOS) path-length limits if `PLUGIN_DATA` is deeply nested.

#### Candidate 3: Shortened Server-Side Lease TTL + Background Heartbeat in `mcp-stdio.mjs`
- **Failure Modes:** Already **rejected** in `epic-6-lease-astra.md:107-118` and `epic-6-retro-2026-10-21.md:122-125`. MCP stdio servers sit idle between tool calls; a short TTL drops healthy sessions or requires a background timer loop in `mcp-stdio.mjs`, and still leaves a dead squat for the full lease duration after a crash.

#### Candidate 4: Client-Reported PID / Boot-ID / Process Lineage Attestation
- **Failure Modes:** Unverifiable by a remote Room Server (`AGENT_ROOM_CONNECTION_MODE=remote`), trivial to spoof or collide across container namespaces, and cannot distinguish two shells under the same terminal emulator.

🏗️ **Winston:** Look at Candidate 2 (`node:net` Unix socket liveness probe + one-time `recovery_ticket`). Unlike Candidates 1, 3, and 4, Candidate 2 actually solves the World A vs World B separation on a single host using only Node 24 built-ins (`node:net`), because the OS kernel itself is the oracle for whether Process 1's file descriptor table still exists! Story 7.4 should explicitly evaluate Candidate 2 on the table.

😤 **Grumbal:** Wait a second, Winston! Look at what Story 7.3 (`A8` + `A9`) already does before Story 7.4 even starts:
Once `mcp-stdio.mjs` handles `SIGTERM` and `SIGINT` and `releaseSession()` races (`7.3`), **when does a dead session ever stay squatted?** Only after `kill -9` (`SIGKILL`), kernel OOM-kill, power loss, or a dropped remote TCP link!
To auto-recover from `kill -9` without typing `agent-room session replace`, Candidate 2 wants us to put a `node:net` Unix domain socket server inside every `mcp-stdio.mjs` child process, manage stale socket unlinking races when two processes start simultaneously after a crash, deal with macOS `104-byte` `sockaddr_un` path limits when `PLUGIN_DATA` is in a deep path, and amend the Spine's rule that takeover is an explicit human decision!
I say: **Story 7.4 in `docs/epics.md` MUST pre-commit to NOTHING**, and the round-table in 7.4 should hold Candidate 2 to a brutal bar where **"documented refusal (keep explicit `agent-room session replace` + Story 7.3 signal-safe teardown)"** is the default baseline unless Candidate 2 clears every race and path-length edge case!

📋 **John:** I agree with Grumbal and Vex on the epic text: **Story 7.4 should pre-commit to nothing in `docs/epics.md`**, while naming the exact falsification criteria the 7.4 round-table must apply to Candidate 2 (and any other proposal).

### Ruling on Question 5 (A2 Direction)
- **Rule:** **Story 7.4 (`docs/epics.md:668-676`) MUST pre-commit to NO implementation mechanism**; its current framing (*"if none exists without weakening the takeover invariant, that refusal is the deliverable"*) is right and should be preserved.
- **Named Candidates & Failure Modes for Story 7.4's Brief:**
  1. **Candidate 1 (Disk-only one-time `recovery_secret` / ratchet in `${PLUGIN_DATA}`):** Fails the **Two-Tab Co-Tenancy Test** (a second live process sharing `${PLUGIN_DATA}` reads the file while Process 1 is still alive and steals its session).
  2. **Candidate 2 (Kernel-enforced `node:net` Unix socket liveness probe in `${PLUGIN_DATA}` + server-bound one-time `recovery_ticket`):** The **only** zero-dependency candidate that separates local process death (`ECONNREFUSED`) from live co-tenancy (`connect` succeeds) without a bearer token or lease timer. **Failure modes to judge in 7.4:** macOS `sockaddr_un` 104-byte path limit on `${PLUGIN_DATA}`, concurrent startup unlink races after a crash, `SIGSTOP` false-dead detection, non-portability across wiped containers/remote hosts sharing a key, and added IPC complexity in `mcp-stdio.mjs` after Story 7.3 already eliminates `SIGTERM`/`SIGINT` squats.
  3. **Candidate 3 (Short lease TTL + background keepalive):** Refused by prior decision (`epic-6-lease-astra.md:107-118`).
  4. **Candidate 4 (Self-reported PID / process-tree claims):** Refused (unverifiable over Remote Mode and across namespaces).

---

## Question 6: Flag Any Recommendation That Conflicts With Prior Recorded Decisions

We audited every recommendation debated above against `HANDOFF.md:214-228` (`DECIDED — DO NOT RELITIGATE`), `ARCHITECTURE-SPINE.md`, `epic-6-lease-astra.md`, and `epic-6-retro-2026-10-21.md`:

| # | Recommendation / Option | Prior Recorded Decision | Conflict Nature & Resolution |
|---|---|---|---|
| **C1** | **Q4 Minority Option (Vex/Grumbal):** Re-running `store.isActorBanned` after `readRequestFields` to cancel slow-streaming requests mid-body when a ban lands. | **Story 4.5 / FR-15 (`docs/epics.md:61`, `HANDOFF.md:220`):** *"Ban ships WITHOUT session revocation — the ban holds at the resource boundary; in-flight requests refused at next request; enforcement latency for an active Long-Poll bounded by the 20s hold window."* | **CONFLICTS with FR-15's "at next request" rule.** If adopted, it silently changes Story 4.5's specified enforcement boundary. Majority (John/Winston) rules: re-run **only** `sessionRegistry.isSuperseded(sessionKey)` after `readRequestFields`. |
| **C2** | **Q3 Option (Winston/Vex):** Checking `!sessionRegistry.isLive(sessionKey)` in `AuthzStage` / post-input revalidation in addition to `isSuperseded(sessionKey)`. | **Story 1.4 / Story 6.4 (`server/api/session.mjs:60-67`):** `AuthzStage` historically only checked the negative `superseded` fence and ban list; `revoke()` (`DELETE /api/session`) or `SESSIONS_MAX` LRU eviction did not trigger the handoff fence. | **Extends authority check beyond handoff supersession to all session invalidations (`revoke` + LRU eviction).** If Story 7.1 wants strictly handoff-fence semantics without changing `SESSIONS_MAX` eviction behavior, use **In-Flight Pinning on `superseded`** (`inFlightCount > 0` never evicted) rather than `!isLive`. |
| **C3** | **Q5 Candidate 2 (Winston/Sally):** Unattended automatic recovery via local Unix socket liveness + one-time `recovery_ticket` on `POST /api/session`. | **Story 6.4 Design Ruling (`epic-6-lease-astra.md:83`, `spec-6-4`):** *"Takeover is an explicit caller decision (`replace_existing: true`) rather than the default behavior of every `POST /api/session`"* and requires an interactive TTY operator confirmation (`agent-room session replace`). | **CONFLICTS with Story 6.4's explicit-only takeover invariant.** Cannot be added without an explicit **Architecture Spine amendment** carving out a distinct, non-interactive `resume_ticket` transition separate from `replace_existing`. |
| **C4** | **Q3 Time-Based Retention / Q5 Candidate 3 (Lease TTL + Heartbeat):** Using wall-clock lease/request TTLs to expire fences or auto-recover sessions. | **Story 6.4 Lease Ruling (`epic-6-lease-astra.md:107-118`, `epic-6-retro-2026-10-21.md:122-125`):** Rejected time-based lease expiry and background heartbeats in `mcp-stdio.mjs` because idle MCP sessions must not lose their Chat ID. | **DIRECT CONFLICT.** Both are refused by all five voices. |
| **C5** | **Story 7.6 (`Where the Heap Goes`):** Calibrating the `retainedState` threshold after investigating Attempt 6's `0.65%/hour` post-GC heap slope. | **Story 4.8 / Story 6.2 Amendment (`HANDOFF.md:212, 223`):** *"Do not broaden the soak's RSS gate — the memory rule is asserted on the settled idle window, not under load."* | **No conflict ONLY IF Story 7.6 keeps FR-13's settled-window RSS gate untouched** and treats `retainedState` strictly as its own calibrated diagnostic (or fixes a concrete retainer without weakening the 2% settled-window RSS bound). |
| **C6** | **Story 7.1–7.6 Packaged Docs (`CHANGELOG.md`, `README.md`):** Updating packaged docs during Epic 7 stories. | **Candidate Immutability Law (`HANDOFF.md:196, 203`) + Retro `A1` (`docs/epics.md:630`):** Freeze applies *only within* an active RC soak; `A1` mandates that every v0.3 story's `CHANGELOG.md` and `README.md` edits land **with the story, before the v0.3 candidate is frozen**. | **Aligned.** v0.3 cuts a fresh candidate; landing `README.md` and `CHANGELOG.md` updates inside Stories 7.1, 7.2, and 7.3 satisfies `A1` and prevents a v0.3 re-cut. |

---

## Plain Statement of What Could and Could Not Be Verified

### Verified Directly Against the Repository (`8a13348`)
- Verified `docs/epics.md:628-698` and `docs/implementation/sprint-status.yaml:89-95, 254-356` against `docs/implementation/epic-6-retro-2026-10-21.md`, `docs/implementation/epic-6-completion-audit.md`, `docs/implementation/reviews/epic-6-release-gate-2026-10-25-resolution.md`, `epic-6-release-gate-codex.md`, `epic-6-release-gate-agy.md`, and `epic-6-lease-astra.md`.
- Verified the exact stage execution order and async `await` boundaries in `server/api/pipeline.mjs:256-634` (specifically that `BudgetStage.process` awaits `readRequestFields` at `line 356` on `POST /api/rooms/:id/messages`, while `runPipeline` awaits `readRequestFields` at `line 618` for all other body-carrying routes).
- Verified every route handler in `server/api/server.mjs:505-1052` to confirm that all eight mutating `actor`-class handlers are 100% synchronous from entry to SQLite/registry commit, and that `readMessages` (`server.mjs:847-875`) awaits inside `handler(context)` on Long-Poll wakeups while checking `isActorBanned` (`line 852`) but not `isSuperseded`.
- Verified `server/api/session.mjs:59-153` (`createSessionRegistry`), `server/core/session-registry.mjs:313-392` (`liveSessionRegistry.transfer`), `server/mcp-stdio.mjs:750-776` (`input.once('close')` without `SIGTERM`/`SIGINT`), `server/client/api-client.mjs:620-690, 932-960` (`releaseSession` token race), and `server/cli/session-commands.mjs:147-180` (`runSessionReplace`).

### Could NOT Be Verified in This Read-Only Session
1. **Root cause of Attempt 6's `0.65%/hour` `retainedState` slope (Story 7.6):** `docs/release-evidence/v0.2.0-soak-attempts/attempt6-3929cc7.gc.jsonl` records aggregate V8 heap bytes after major GCs (`usedHeapAfterGcBytes`), not per-constructor retainer graphs (`.heapsnapshot`). We could not verify without running a heap-snapshot diff whether the ~0.33 MiB / 4h rise is bounded SQLite/V8 warmup or a slow retainer in `server/`.
2. **Signal-delivery behavior of third-party vendor parent binaries (`zcode` 0.17.0, `claude` 2.1.306) on non-EOF termination (Story 7.3 / 7.4):** We could not verify from repository files alone whether `zcode -p` sends `SIGTERM`/`SIGINT` before exiting or immediately `SIGKILL`s its MCP child; Story 7.3's real-child test will prove signal handling, and REL-1 preflight/smoke will confirm vendor host behavior.
3. **Runtime execution of the proposed fixes:** Because this session operated under a strict `READ-ONLY` mandate, no code in `server/` or `tests/` was modified or executed with the proposed changes.

---

## Each Voice's Bottom Line

- 📋 **John (Product Manager & Ledger Custodian):**
  > **Keep the 6-story split (`7.1–7.6`) and the authored order (`7.1 → 7.2 → 7.3 → 7.4`, with `7.5` & `7.6` parallelizable).** Expand Story 7.1's AC to sweep all four packaged files that narrate the old A5 window (`pipeline.mjs`, `server.mjs`, `session-commands.mjs`, `README.md`/`CHANGELOG.md`) plus the `README.md:197` fossil, require same-Actor gating on Story 7.2's conflict ticket, keep A5's post-input check strictly to `isSuperseded` (do not touch FR-15's ban semantics), and pre-commit Story 7.4 to nothing.

- 🏗️ **Winston (Systems & Concurrency Architect):**
  > **Reorder to `7.1 → 7.3 → 7.4 → 7.2` so `POST /api/session` and the Spine are only amended once, and fix Story 7.1's A7 draft before coding:** register in-flight `sessionKey`s in `runPipeline` immediately after `AuthStage` (before `BudgetStage`'s `await readRequestFields` at `pipeline.mjs:356`) inside a `try / finally`, pin `inFlightCount > 0` entries in `superseded` unconditionally (`maxSessions` bounds only `inFlightCount === 0` idle tombstones), and add the 1-line `isSuperseded` check on Long-Poll wakeup at `server/api/server.mjs:852`.

- 🔒 **Vex (Security & Session-Authority Reviewer):**
  > **Approve the A5 placement in `runPipeline` right after `readRequestFields(context)` (`pipeline.mjs:618`), enforce same-Actor confidentiality on Story 7.2's conflict ticket, and hold Story 7.4 to the Two-Tab Co-Tenancy Test.** A disk file in `${PLUGIN_DATA}` is not ownership evidence because two live tabs share `${PLUGIN_DATA}`; without a kernel-enforced liveness oracle (`node:net` Unix socket `ECONNREFUSED`), any disk token silently hijacks a live session. Also re-run full `AuthzStage` (fence + ban) when `readRequestFields` actually awaited a stream, and check `isSuperseded` on Long-Poll wakeups.

- 🎨 **Sally (Operator & Client UX Designer):**
  > **Run `7.4` before `7.2` so `agent-room session replace` and `POST /api/session` are designed coherently, and enforce `A1` across every story in Epic 7.** Story 7.1 must clean up every comment and `README.md` paragraph where the third re-cut (`3929cc7`) documented the temporary A5 window, or v0.3 will ship docs that underclaim its own guarantees.

- 😤 **Grumbal (Adversarial Gatekeeper):**
  > **Refuse Story 7.1's draft "the old count bound stays as a backstop" wording — a backstop that evicts `inFlightCount > 0` entries is still an exhaustible fence.** Pin `inFlightCount > 0` entries unconditionally, bracket admission in `runPipeline` right after `AuthStage` in `try / finally` (never inside `AuthStage.process` standalone), land Story 7.3 (`SIGTERM`/`SIGINT` release) before debating Story 7.4, and make "documented refusal" the default outcome of Story 7.4 unless Candidate 2 (`node:net` Unix socket + one-time ticket) proves it cannot race or choke on `sockaddr_un` path limits.

TEAM_DONE epic-7-shape-agy