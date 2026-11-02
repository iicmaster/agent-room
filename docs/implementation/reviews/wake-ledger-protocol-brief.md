You are READ-ONLY architecture advisors. Do not edit code, run production probes, commit, push or publish. Write only the named outbox.

QUESTION: choose a correct, bounded cross-process implementation for agent-room's client-local held-wake ledger, shared by the always-on MCP notifier and independent `agent-room wait` CLI. This has resisted multiple iterations: v0.7 JSON read/decide/atomic-rename races; both advisor reviews and an implementation audit confirmed TOCTOU and unbounded per-sender state. Operator rule: after >3 repeats of the same blocker, consult codex + agy, bring findings to party-mode and let party decide technical direction autonomously. Current objective: finish DDD migration; preserve first-contact wake / cooldown / aggregate budget without body leak or message consumption.

CURRENT SOURCE FACTS (verify):
- `server/notification/wake-policy.mjs:64-94` loads a JSON `{version:1,perSender,heldWakes}` file, computes cooldown and budget, uses `atomicWriteJson`; read/decide/write is not a cross-process transaction; perSender keys are not pruned; fail-open on read/write failure.
- Two separate processes can call this path concurrently: `server/notification/notifier.mjs` in MCP and `server/cli/wait-commands.mjs`.
- Project: Node >=24, built-ins only, native `node:sqlite`; server DB uses STRICT, WAL, synchronous=FULL, foreign_keys=ON, busy_timeout 5000; owner-only state: dirs 0700, files 0600; no Unix sockets; local-first; no server-held client trust state.
- `server/runtime.mjs:148-158` `atomicWriteJson` atomically replaces JSON but does not serialize the read+decision transaction. `ensurePrivateDirectory` does lstat/refuse symlink then mode 0700; race-safe file path concern remains.
- `decideHeldWake` currently synchronous; callers can be converted async. MCP main event loop must not block for an unbounded period. DatabaseSync is synchronous; a worker thread is a viable built-in option.
- Operator-approved product policy: first eligible held contact may wake; same untrusted sender repeats cooldown 300,000ms; aggregate held-wake budget 10 per 60,000ms. Trusted messages bypass held wake budget; suppressed held rows are not consumed. Current wait classifier is now fixed and tests exercise Local, configured HTTPS and declared remote-on-loopback. `tests/wake-command.test.mjs`, `tests/notifier.test.mjs`, `tests/wake-policy.test.mjs` hold coverage.

CANDIDATE PROTOCOL (not ratified; critique it):
A. One client-local SQLite sidecar per installation+realm: `PLUGIN_DATA/realms/<realm>/wake-state.sqlite`; tables `wake_policy_meta`, `sender_cooldowns`, `held_wakes`. `BEGIN IMMEDIATE` around prune+check+grant. Strict/WAL/FULL/FK, file+WAL+SHM 0600, parent 0700. One DatabaseSync connection in a persistent Worker thread per process; bounded queue 64; busy_timeout 50ms inside worker; caller nonblocking. No new external dependency/service/socket. Policy tuple is initialized once from fixed defaults/env and stored; future writers must match; mismatch returns a deterministic config refusal before processing.
B. Retain JSON but introduce owner-only lock protocol for cross-process transaction. Critique crash/stale-owner/PID reuse, O_EXCL races, bounded timeout and degraded semantics. Do not recommend JSON atomic rename alone.
C. Other minimal alternative consistent with project constraints; state concrete tradeoffs.

PROPOSED DEGRADED POLICY: first eligible wake outranks bookkeeping. If SQLite is missing/corrupt/unreadable, ENOSPC, busy timeout, worker unavailable or commit fails: emit eligible wake, mark degraded, log one rate-limited diagnostic; do not claim aggregate cap in degraded windows. Policy tuple mismatch is a separate configuration error (not fail-open): no policy decision until operator fixes it. No JSON fallback/dual authority. Grant is committed before output; crash/output failure can consume cooldown without visible hint (at-most-once signal gap, explicitly accepted). For `wait`, probes must be pure; select deterministic winner first, only winner reserves; abort/drain losers before lock release.

QUESTIONS: (1) Is sidecar SQLite + worker-thread actually safer than lockfile? Any policy/runtime violation? (2) exact schema/transaction/initialization and migration from JSON v1; handling missing/corrupt/unknown schema; atomic marker; mixed version. (3) bounded queue/busy/retry/stale worker/timeout behavior. (4) bounded storage/retention, time jumps, env tuple semantics. (5) Permissions/symlink race proof. (6) grant/output and wait loser semantics. (7) tests with executable AC, include 40-process budget race, 20 same-sender race, crash, ENOSPC, corrupt, mixed config, body secrecy, no cursor change. (8) stop conditions: when is prototype rejected rather than “adjusting” acceptance? Distinguish proven vs proposal.

Answer as a bmad-party-mode round-table using EXACTLY the saved party described below. Each voice argues with distinct lens; preserve disagreements; end with each bottom line; state what you could not verify.

<<<PARTY-ROSTER
Party: Anti-Consensus Club (anti-consensus-club)
- 🃏 Wildcard — Option Generator: Wildcard looks for alternatives, simpler assumptions, explains why each matters, drops unhelpful ideas.
- 📏 Level — Claim Checker: Level checks source evidence, missing evidence, confidence and falsifiability.
- 🛑 Killjoy — Loop Stopper: Killjoy challenges repetition, overbuilding and unsupported claims; asks what unresolved decision matters.
- 🪵 Splinter — Consensus Challenger: Splinter challenges easy agreement, hidden assumptions and overlooked tradeoffs.
Scene: Support operator judgment, no vote, no authority claim; real disagreement must remain visible.
PARTY-ROSTER>>>

OUTPUT: write complete review to `.mailbox-out/wake-ledger-__VENDOR__` under repo root. Read-only; write only the outbox.