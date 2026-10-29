# Release-Gate Round-Table — `agent-room` v0.3.0 (`v030-release-gate-agy3`)

**Overall Verdict: UNANIMOUS REFUSE (5–0 REFUSE: Winston, Vex, John, Sally, and Grumbal ALL REFUSE candidate `129f702` — DO NOT TAG `v0.3.0`).**

- **Task ID:** `v030-release-gate-agy3`
- **Repository:** `/Users/ngs/agent-skills/plugins/agent-room` (branch `main`, `HEAD` `b7b0b04f18e925cd163b9d22927d7683d26615f8`)
- **Evaluated Candidate:** `129f70235477c8bfe893ad39c9d70e0a68908793` (`docs/release-evidence/v0.3.0-candidate.json`, version `0.3.0`)
  - Portable package (`agent-room-agent-plugin`): `47` files, `829486` bytes, SHA-256 `beb2d2af239e6f37501109a83f2efcc44a60409c76ef6d4139c892fbf73c0054`
  - Claude Code package (`agent-room-claude-code`): `47` files, `829346` bytes, SHA-256 `4510d48448fa45c6febc525643853eb87a48537d44940be5e325f81081ca0880`
- **Mode:** Strictly READ-ONLY repository inspection and verification. The sole write performed is this outbox file.
- **The Decisive Blocker:** `server/runtime.mjs:20` still declares `export const APP_VERSION = '0.2.0'`. Commit `129f702` updated `plugin.json`, `package.json`, `scripts/package-release.mjs`, and `CHANGELOG.md` to `0.3.0`, but omitted `server/runtime.mjs`. Consequently:
  1. The full test suite FAILS: `node --test tests/package.test.mjs` fails 3 assertions (`tests/package.test.mjs:240`, `:285`, `:724`).
  2. The packaged server runtime lies about its version over every live wire endpoint (`GET /health`, `GET /api/status`, `GET /viewer/api/status`, and MCP `initialize` `serverInfo.version: '0.2.0'`).
  3. Repairing `server/runtime.mjs` modifies a packaged entry (`server/`), which under the **Candidate Immutability Law** (`docs/release-evidence/v0.3.0-candidate.json:6`) **voids candidate `129f702`**. A fresh candidate must be cut.

---

## Seats at the Round-Table (`bmad-party-mode`)

- 🏗️ **Winston** — Systems, Packaging & Concurrency Architect (runtime isolation, packaging determinism, in-memory digest verification, event loops, process lifecycles)
- 🔒 **Vex** — Security, Authority & Public-Exposure Auditor (trust boundaries, secret scanning, wire protocol invariants, authorization fences, exposure risk)
- 📋 **John** — Product Manager & Governance Custodian (scope integrity, Epic 7 completion, AC sweep, SemVer / minor-version contracts, retro action-item tracking)
- 🎨 **Sally** — Operator UX & Release Communications Reviewer (clarity and honesty of release notes, CLI ergonomics, error reporting, operator expectations)
- 😤 **Grumbal** — Adversarial Release Gatekeeper (skeptic of "unsoaked" releases, finding hidden edge cases, questioning waivers, checking exact words against shipped code)

---

## 1. Independent Verification of Concrete State & Load-Bearing Evidence

Before debating the release mandate, every fact in the prompt and repository was verified autonomously:

1. **Working Tree & Ancestry (`129f702..b7b0b04`):**
   - `git status`: working tree clean.
   - `HEAD`: `b7b0b04f18e925cd163b9d22927d7683d26615f8`.
   - `git merge-base --is-ancestor 129f702 HEAD`: exit code `0` (`129f702` is direct ancestor of `HEAD`, exactly 1 commit behind).
   - `git diff 129f702..HEAD`: touches **only** two files under `docs/`: `docs/release-evidence/v0.3.0-candidate.json` (35 insertions) and `docs/release-notes-v0.3.md` (75 insertions).
   - `git diff 129f702..HEAD -- plugin.json mcp.json server web README.md LICENSE CHANGELOG.md package.json scripts/package-release.mjs`: **empty (0 files changed)**.

2. **In-Memory Package Construction & SHA-256 Digest Verification:**
   - Evaluated the in-memory transform and `treeDigest` fold matching `scripts/package-release.mjs:223-259` and `tests/release-smoke.test.mjs:248-271`:
     - `portable` (`agent-room-agent-plugin`): 47 files, 829,486 bytes, SHA-256 `beb2d2af239e6f37501109a83f2efcc44a60409c76ef6d4139c892fbf73c0054` — **exact match** to candidate record.
     - `claude_code` (`agent-room-claude-code`): 47 files, 829,346 bytes, SHA-256 `4510d48448fa45c6febc525643853eb87a48537d44940be5e325f81081ca0880` — **exact match** to candidate record.
   - Executed `node --test tests/release-smoke.test.mjs`: passed 5/5 subtests green in 6.6 s, including `claude plugin validate --strict` reporting `exit_code: 0`, version `2.1.312 (Claude Code)`.

3. **AC Sweep & Evidence Traceability:**
   - Executed `node scripts/ac-sweep.mjs --epic 7`:
     - Output: `Epic 7: 6 stories · 11 criteria · 23 evidence pointers · 648 tests in suite` -> **Verdict: clean**.
   - Executed `node scripts/ac-sweep.mjs --epic 1..5`: all clean.
   - Executed `node scripts/ac-sweep.mjs --epic 6`:
     - Output: **Verdict: gaps** (`- 6.4 cites a test that does not exist in the suite: "two competing takeovers: the last explicit intent wins, and the loser is fenced"`).
     - *Cause:* Story 7.2 updated `tests/session-replacement.test.mjs:289` to `Story 7.2: two independent observations — the observed incumbent wins, and the stale observation is refused`, reflecting the wire change. `docs/implementation/ac-evidence.yaml:1656` under Epic 6.4 was not retroactively updated to note this test renaming.

4. **Test Suite Execution (`node --test`):**
   - **Parallel outer run check:** Discovered that the outer dispatch running in background (`PID 21243`) failed at `tests/release-smoke.test.mjs` because the shell snapshot `snapshot-zsh-*.sh` lacked `/Users/ngs/.local/bin` in its PATH, causing `resolveClaudeBinary()` to fail.
   - **Full test execution run:** Ran `node --test $(ls tests/*.test.mjs | grep -v release-smoke)`: 580 tests run, **577 passed, 3 failed**.
   - **The 3 failures:** All located in `tests/package.test.mjs`:
     - `tests/package.test.mjs:240`: `portable manifests and package metadata have exact closed shapes` (expected version `0.2.0`, actual `0.3.0`).
     - `tests/package.test.mjs:285`: `release packaging creates two materialized byte-identical runtime artifacts` (expected version `0.2.0`, actual `0.3.0`).
     - `tests/package.test.mjs:724`: `the validate gate is load-bearing: an unknown manifest field fails it in strict mode` (expected version `0.2.0`, actual `0.3.0`).
   - *Root Cause:* `server/runtime.mjs:20` still has `export const APP_VERSION = '0.2.0'`. `tests/package.test.mjs` imports `APP_VERSION` from `server/runtime.mjs` to compare against `package.json` / `plugin.json`.

5. **Secrets & Public Exposure Scan:**
   - Executed `node scripts/rel1-verify-evidence.mjs`: 18/18 checks pass (`[PASS] SECRETS scanned 14 file(s)`).
   - Scanned all 51 modified/added files across `v0.2.0..HEAD`: 0 private keys, 0 session tokens, 0 cloud credentials, 0 leaked tokens.
   - IP addresses: only loopback, RFC 1918 example `192.168.1.20` in runbook, and already-public test host `43.229.78.103` in historical evidence.

---

## 2. The Round-Table Debate

### Topic I — The Decisive Blocker: `APP_VERSION = '0.2.0'` in `server/runtime.mjs`

**😤 Grumbal:** Stop everything. We do not even need to debate philosophy. Look at `server/runtime.mjs:20`:
```javascript
export const APP_VERSION = '0.2.0'
```
Commit `129f702` was titled *"chore(v0.3.0): the release stamp — 0.3.0 in the manifests and the dated changelog"*. The author changed `package.json`, `plugin.json`, `scripts/package-release.mjs`, and `CHANGELOG.md`. But they completely forgot `server/runtime.mjs`! 
Look at what happens when you run `node --test tests/package.test.mjs`: THREE test failures!
- Line 240: expected version `'0.2.0'` (derived from `APP_VERSION`), actual `'0.3.0'`.
- Line 285: expected version `'0.2.0'`, actual `'0.3.0'`.
- Line 724: expected version `'0.2.0'`, actual `'0.3.0'`.
The test suite is RED. The standing rule in our prompt says plainly: *"the release MUST NOT be tagged before the green run lands."* It is not green.

**🏗️ Winston:** It is worse than just three test failures, Grumbal. `APP_VERSION` is imported by:
- `server/api/server.mjs` (`GET /health`, `GET /api/status`, `GET /api/presence`)
- `server/api/viewer.mjs` (`GET /viewer/api/status`)
- `server/mcp-stdio.mjs` (`serverInfo: { name: 'agent-room', version: APP_VERSION }`)
- `server/client/ensure-server.mjs` (`majorOf(record.version) !== majorOf(APP_VERSION)`)
- `server/daemon-client.mjs` (`DAEMON_CLIENT_VERSION = APP_VERSION`)
If we were to ship candidate `129f702`, an operator installs package `0.3.0`, connects via MCP or queries `GET /api/status`, and the server tells them: `{"version": "0.2.0"}`! The runtime literally reports the wrong release version.

**📋 John:** And look at the release governance contract. The frozen candidate record (`docs/release-evidence/v0.3.0-candidate.json:6`) establishes the **Candidate Immutability Law**:
> *"The v0.3.0 release gate (both vendor advisors, one round over the whole release diff) pins THIS candidate. Any change to server/ or the packaging inputs after this freeze voids the candidate: cut a new one (re-materialize, re-run the gates) before shipping."*

`server/runtime.mjs` is inside `server/`. It is a packaged input in both `portableEntries` and `sharedEntries` (`scripts/package-release.mjs:49-50`). You cannot "hotfix" this without changing the bytes of `server/runtime.mjs`. That immediately voids candidate `129f702` and voids the recorded SHA-256 tree digests (`beb2d2af...` and `4510d484...`). This candidate is dead on arrival.

**🎨 Sally:** I agree with John, Winston, and Grumbal. We cannot ship an RC that calls itself `0.2.0` on the wire and fails its own packaging smoke tests. In v0.2.0, commit `fcf5504` was specifically added to fix this exact issue before candidate freeze! Here, someone rushed the freeze record before `server/runtime.mjs` was stamped.

**🔒 Vex:** Unanimous on this point. Candidate `129f702` is REFUSED. But we are tasked with judging the release *as a whole* so the next candidate cut has clear, actionable resolution for all five mandate questions. Let us walk through points (a) through (f).

---

### Topic II — Question (a): The Wire Change (Story 7.2) and SemVer Policy

**📋 John:** Question (a) asks: *Is the retirement of the blind takeover adequately disclosed (release notes, CHANGELOG 0.3.0, README, the Spine AD-8 amendment) for a minor-version bump? Anything missing for v0.2.0 clients?*
Let's trace the disclosure:
1. `docs/release-notes-v0.3.md:25-28`:
   > **Wire change (deliberate, dated in the Architecture Spine):** `replace_existing: true` now REQUIRES `conflict_ticket` — v0.2.0 clients sending the blind shape get a 400 `invalid_request`.
   And in the upgrade section (`lines 73-74`): *"If you scripted the takeover API: add the two-step (observe → present the ticket); the blind shape is a 400."*
2. `CHANGELOG.md:24-40`: Fully describes the requirement of `conflict_ticket`, redemption against generation, `conflict_stale` (409), and explicitly notes the retirement of the v0.2.0 blind-takeover wire shape as a deliberate, dated wire change.
3. `ARCHITECTURE-SPINE.md:109, 115`: Formally amends AD-8 with the dated 2026-10-29 entry.
4. `README.md:55-65`: Explains `agent-room session replace`. Note that `README.md` only documents the CLI command and MCP tools. Wire endpoints like `/api/session` were never in `README.md`.

**😤 Grumbal:** Hold on, John. In `ARCHITECTURE-SPINE.md:104-115`, AD-8 claims: *"Wire API surface (v1): routes, vocabulary, and envelope are frozen contracts... Additions only, per NFR-8 additive policy."* 
Retiring the blind `replace_existing: true` shape and making it return 400 `invalid_request` is NOT additive — it is a breaking change to the wire contract! Why is a breaking wire change happening in a minor version bump `0.2.0 -> 0.3.0`?

**🏗️ Winston:** Because under SemVer 2.0.0, clause 4 explicitly states: *"Major version zero (0.y.z) is for initial development. Anything MAY change at any time. The public API SHOULD NOT be considered stable."* 
More importantly, Grumbal, keeping a "blind fallback" would leave the A6 vulnerability wide open! If the server permitted blind takeovers, any script could continue blindly displacing incumbents without observing whether the holder changed. You cannot fix a TOCTOU race condition by keeping an opt-in bypass that preserves the race.
And consider who this affects: did ANY stock v0.2.0 MCP adapter use `replace_existing`? No! Look at `server/client/api-client.mjs:456`: the MCP adapter NEVER carried `replace_existing`. The only caller in v0.2.0 was `agent-room session replace`. Third-party custom HTTP callers are the only ones affected, and they are explicitly addressed in the release notes and CHANGELOG.

**🔒 Vex:** From a security standpoint, the blind takeover was an authority hazard. If client A crashed and client B legitimately claimed the Chat ID 500 ms later, client A's operator running a blind script would blow away client B's live session without realizing it. Enforcing `conflict_ticket` binds the displacement to the exact observed generation. The wire change is not only adequately disclosed; it is mandatory for correctness.

---

### Topic III — Question (b): The Story 7.4 Automatic-Recovery Refusal (A2)

**🎨 Sally:** Question (b): *Is the 7.4 refusal honest? Does anything overclaim?*
In `docs/release-notes-v0.3.md:50-57`:
> **Automatic recovery: answered with a recorded refusal (A2)**
> The design round-table refused all four candidate mechanisms — the strongest of them (a kernel-enforced liveness probe) on primary-source evidence: `ECONNREFUSED` is not a death certificate on macOS (a LIVE listener can return it). The supported recovery remains the explicit takeover; narrow prior delegation to a named supervisor is recorded as a possible future policy, not ratified.

And in `docs/epics.md:678`:
> *OUTCOME (2026-10-28): RECORDED REFUSAL — the deliverable... One vendor of record (codex `gpt-6.1-sol[ultra]`; the agy seat quota-exhausted — substitution disclosed per the playbook).*

**🔒 Vex:** This disclosure is exceptionally honest. It does not try to hide the fact that only one vendor was available due to quota exhaustion, which is permitted under our playbook when disclosed. Furthermore, the technical grounds for refusal are rock-solid:
1. Candidate 1 (Disk secret): Fails the Two-Tab Co-Tenancy test. Two processes under the same user share `PLUGIN_DATA`; a secret on disk cannot prove which tab crashed and which tab is a rogue competitor.
2. Candidate 2 (UDS socket probe): The assumption that `ECONNREFUSED` proves death was refuted directly from Apple XNU kernel sources (`uipc_usrreq.c`). A live listener whose listen queue overflows or hits memory allocation failure returns `ECONNREFUSED`.
3. Candidate 3 (Shortened lease + heartbeat): Silence is not death. MCP processes experience normal idle pauses; background timers fail across system sleep or SIGSTOP.
4. Candidate 4 (Self-reported PID): Completely unprovable over Remote Mode.
There is zero overclaiming in the shipped text. The explicit CLI takeover remains the only supported recovery path, and the limitations (SIGKILL, OOM, power loss) are stated without evasion.

---

### Topic IV — Question (c): The 12-Hour Soak Prerequisite Rule

**😤 Grumbal:** Now we reach the hard question in the prompt: *RULE: May v0.3.0 ship on the suite + the gate chain without a fresh 12-hour soak, given (i) the changed surface is session authority (takeover/teardown/fence), not the memory-bound traffic path, (ii) every story has real-child/gated tests, (iii) the memory-relevant change is bounded in-memory maps (tickets: 4096×record)? Or is a fresh soak REQUIRED before the tag? Rule plainly.*
In v0.2.0, we ran Attempt 6 for 724 minutes (12 hours). Candidate record line 34 admits: *"a QUALIFYING soak against THIS record has not been run — the release gate below decides whether v0.3.0 ships without one"*.
I argue this: If you ship v0.3.0 without a soak, you are abandoning empirical endurance verification for analytical speculation. Story 7.1 introduced an unevictable pinned fence! What if an edge case in `runPipeline` fails to release the pin in `finally`? You would have an unbounded memory leak.

**🏗️ Winston:** Grumbal, let us look at the code rather than fears:
1. **The Pinned Fence (`server/api/pipeline.mjs` & `server/core/session-registry.mjs`):** The pin is acquired inside `runPipeline` synchronously upon successful authentication and is released in a top-level `finally` block enclosing all execution paths. In `tests/session-replacement.test.mjs:971`, the test *"Story 7.1: the pin is released exactly once across every pipeline exit shape"* exhaustively exercises normal returns, handler rejections, auth rejections, budget aborts, and early aborts. When pin count reaches zero, idle entries are strictly bounded by `liveSessionRegistry.fenceCapacity = 1000`.
2. **Conflict Tickets (`server/api/conflict-tickets.mjs`):** The ticket store is explicitly capped at `MAX_TICKETS = 4096`, max 16 tickets per session, TTL of 300 seconds, and sweeps every 60 seconds. A full store rejects new tickets with `rate_limited` rather than growing the heap.
3. **The Soak Harness Validation:** `tests/soak/rel3-soak.test.mjs` executes the full 5-minute compressed profile with real child processes and passes green.
4. **Story 7.6 Disposition:** Story 7.6 analyzed Attempt 6's `--trace-gc` log in `tests/rel3-retained-state-disposition.test.mjs` and proved that the `retainedState: rising (0.65%/h)` observation was an artifact below the instrument's measurement resolution (the 9.2 MiB mode held for 9+ hours; the true robust slope was 0.00%/h).
None of the code changed in Epic 7 modifies the memory-bound traffic path (message send/read/long-poll, SQLite WAL checkpoints, or SSE buffers). Requiring a 12-hour quiet-host run for a session-authority repair release that touches only bounded control structures is an unwarranted release tax.

**📋 John:** Governance supports Winston. Story 6.2 (the formal soak) was a specific milestone story for Epic 6 (v0.2.0). Epic 7 has its own ratified 6 stories (7.1–7.6), none of which mandated a new 12-hour soak.
**OUR RULING:**
> **v0.3.0 MAY SHIP without a fresh 12-hour soak**, because:
> (1) The modified surface is strictly session authority and process shutdown; the steady-state traffic engine, database journal, and long-poll dispatch loops are untouched.
> (2) Every newly introduced in-memory structure is strictly bounded (`conflict-tickets` capped at 4,096 entries / 16 per session; idle fence capped at 1,000 entries).
> (3) Real-child and signal-handling tests comprehensively verify pin acquisition and release across all error paths.
> (4) The candidate record explicitly and honestly discloses: *"a QUALIFYING soak against THIS record has not been run"*, avoiding any false claim of empirical 12-hour endurance on v0.3.0 bytes.

**😤 Grumbal:** I will concede the rule under one non-negotiable condition: The release notes and candidate freeze record must maintain their current honesty and NEVER claim that v0.3.0 was 12-hour endurance-tested. The endurance baseline remains Attempt 6 (`3929cc7`).

---

### Topic V — Question (d): Packaged Text Integrity (README / CHANGELOG)

**🎨 Sally:** Question (d): *Any overstated guarantee, any A5-window-era prose left, any place the new takeover semantics are described wrong?*
We performed full-text searches across `README.md` and `CHANGELOG.md`:
- "does not cancel": zero hits.
- "one window": only occurs in `CHANGELOG.md:65` as historical context (*"v0.2.0's 'one window' disclosure stands as that release's honest record"*), and in rate-limit/duplicate gate contexts.
- `README.md:75-83` now explicitly documents the total fence:
  > *"The fence is total. Every request the displaced session had in flight is refused: the stage check refuses it as early as its stage sequence reaches, and the pipeline re-checks the fence after the request's fields have fully resolved and directly before the handler — no handoff can interleave between that final check and the mutating handlers. The displaced session's fence entry survives until no request of its own can still be in flight."*
- `README.md:84-95` documents the signal-safe teardown:
  > *"The MCP adapter's teardown paths — stdin closing, SIGTERM, SIGINT — join ONE bounded shutdown operation... inside the declared 2,000 ms bound..."*
The text is crisp, accurate, and free of obsolete A5-era claims.

---

### Topic VI — Question (e): Secret & Public Exposure in Tracked Tree

**🔒 Vex:** Question (e): *Anything in the tracked tree that must not go public (delta since v0.2.0)?*
We examined all 51 changed files between `v0.2.0` and `HEAD`:
- Secret scanner over private key PEM headers, AWS patterns, GitHub PAT tokens, invite token prefixes (`ar_inv1_`), and passwords returned **0 findings**.
- `node scripts/rel1-verify-evidence.mjs` passes all 18 structural checks, confirming the REL-1 evidence bundle is clean.
- The only IP address in the delta is `192.168.1.20` in `docs/rel1-runbook.md` (an RFC 1918 private documentation example), and `43.229.78.103` in `ac-evidence.yaml` which was already public in v0.2.0.
The tree is completely safe for public distribution.

---

### Topic VII — Question (f): Flagged Conflicts with Prior Recorded Decisions

**📋 John:** Question (f): *Flag any recommendation that conflicts with prior recorded decisions.*
We flag three critical items:
1. **The Candidate Immutability Law (`docs/release-evidence/v0.3.0-candidate.json:6`):** Anyone proposing to "simply edit `server/runtime.mjs` and tag commit `b7b0b04`" directly violates the law. Editing `server/` changes packaged bytes, altering the package digests. Candidate `129f702` MUST be voided and a new candidate recorded.
2. **The Standing Suite Green Rule:** Tagging while `tests/package.test.mjs` fails violates the standing release requirement.
3. **Governance Drift in `ac-evidence.yaml` (Epic 6.4):** In `docs/implementation/ac-evidence.yaml:1656`, Epic 6.4 points to the test name `"two competing takeovers: the last explicit intent wins, and the loser is fenced"`. Story 7.2 updated this test to `"Story 7.2: two independent observations — the observed incumbent wins, and the stale observation is refused"`. Running `node scripts/ac-sweep.mjs --epic 6` reports a gap. While `ac-evidence.yaml` is not a packaged release asset, this pointer drift should be updated during the next freeze so the entire suite sweep across all epics remains clean.

---

## 3. What Was Verified vs. What Could Not Be Verified

### Verified Directly:
- Git working tree status, commit history, and exact diffs for `129f702` and `b7b0b04`.
- In-memory execution of packaging transforms and `treeDigest` SHA-256 hash calculations matching `v0.3.0-candidate.json` bit-for-bit (`beb2d2af...` and `4510d484...`).
- Direct execution of `node --test tests/release-smoke.test.mjs` (5/5 pass, `claude plugin validate --strict` exits 0 with Claude Code 2.1.312).
- Direct execution of `node scripts/ac-sweep.mjs --epic 7` (clean: 6 stories, 11 criteria, 23 pointers).
- Direct execution of `node scripts/rel1-verify-evidence.mjs` (18/18 checks pass).
- Full automated secret and regex scan across all 51 files modified since `v0.2.0`.
- Execution of `node --test` across the test suite, isolating the 3 failing tests in `tests/package.test.mjs`.

### Not Verified / Stated Plainly:
- Did not run physical two-machine network drills across remote hosts during this turn (relied on the verified REL-1 bundle and Story 7.5 recomputations).
- Did not run a fresh 12-hour wall-clock soak against candidate `129f702` (as ruled in Topic IV).
- The outer dispatch's parallel background test run was tainted by an environmental PATH deficiency (`~/.local/bin` omitted from the subshell snapshot).

---

## 4. Each Voice's Own Bottom Line

- 🏗️ **Winston (Systems & Concurrency Architect):**
  > **REFUSE candidate `129f702`.** The packaging digest calculation is deterministic, and the architectural bounds on the new session-authority structures are sound. But `server/runtime.mjs` declaring `APP_VERSION = '0.2.0'` causes the server to misreport its own identity across HTTP and MCP, and causes `tests/package.test.mjs` to fail. Fixing `server/runtime.mjs` modifies packaged bytes and voids candidate `129f702`. Bump `APP_VERSION` to `'0.3.0'`, re-cut the candidate, verify the clean suite, and then tag.

- 🔒 **Vex (Security & Authority Auditor):**
  > **REFUSE candidate `129f702`.** The wire change in Story 7.2 is an essential security fix against TOCTOU session hijacking, the Story 7.4 refusal is honest and kernel-grounded, and the git history is 100% clean of credentials. However, shipping an artifact with version mismatch between manifests and runtime code violates basic provenance integrity. Fix the version constant, re-materialize, and cut a fresh candidate.

- 📋 **John (Product Manager & Governance Custodian):**
  > **REFUSE candidate `129f702`.** Under the Candidate Immutability Law, candidate `129f702` cannot be tagged with failing tests, nor can it be patched without voiding the freeze. The path forward is unambiguous: (1) update `server/runtime.mjs:20` to `'0.3.0'`, (2) update `docs/implementation/ac-evidence.yaml:1656` to cite the updated 7.2 test title, (3) re-run the full 648-test suite to green, (4) cut a new candidate freeze record with the newly materialized package digests, and (5) tag the new candidate.

- 🎨 **Sally (Operator UX & Release Communications Reviewer):**
  > **REFUSE candidate `129f702`.** An operator reading release notes for v0.3.0 who queries `/health` or `/api/status` and receives `0.2.0` will immediately assume their installation or upgrade failed. The release communications in `README.md` and `CHANGELOG.md` are pristine and honest, but the shipped runtime constant must match the release label.

- 😤 **Grumbal (Adversarial Release Gatekeeper):**
  > **REFUSE candidate `129f702`.** The prompt instructed us: *"the release MUST NOT be tagged before the green run lands."* The suite is NOT green (`tests/package.test.mjs` failed 3 tests). On the 12-hour soak, I accept the round-table's ruling to waive it for this session-authority repair ONLY because the candidate record explicitly disclaims it. But on the version stamp, there is zero room for compromise. Reject candidate `129f702`. Stamp `server/runtime.mjs`, re-materialize, run the suite to 100% green, and present the next candidate.

---

TEAM_DONE v030-release-gate-agy3
