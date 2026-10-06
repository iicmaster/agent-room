# Epic 6 Execution — agy-advisor (gemini)

## John (PM): Sequence the gates, protect the milestone, never ship on "open items"
We cannot demonstrate a system that has not yet been built, packaged, and proven stable. The sequencing of Epic 6 must be strictly dependency-driven: **Story 6.3 (Packaging & Smoke) → Story 6.2 (Formal 8-Hour Soak) → Story 6.1 (Physical REL-1 Demo)**.

1. **Why 6.3 first?** Testing a loose development workspace in a 8-hour soak or a multi-machine demo is an anti-pattern. Story 6.3 produces the immutable Release Candidate (RC) artifacts (`package-release.mjs`), executes `claude plugin validate --strict`, validates client smoke tests, and measures the SM-C1 baseline across five fresh installs. Every byte soaked in 6.2 and touched by the human in 6.1 must come directly from this verified candidate artifact.
2. **Why 6.2 second?** Human time is our most expensive resource. Asking the human operator to orchestrate two machines, two client vendors, and screen recording against a server that might leak file descriptors or crash after 4 hours of traffic is terrible project management. Soak the RC first. Once 6.2 completes with green metrics, the human knows the engine is bulletproof.
3. **Status hygiene:** To question 1: it is entirely legitimate for the autonomous agent to complete 6.2 and 6.3 while 6.1 remains open. However, **Epic 6 cannot be marked "accepted" or "shipped" with open items.** The epic tracking status during this interval must be explicitly `IN_PROGRESS (Awaiting Physical REL-1 Demo)`. In PM terms, "accepted-with-open-items" is release debt. Release v0.2.0 cannot be tagged or distributed until 6.1 passes.
4. **Agent's obligation for 6.1:** The autonomous agent must not dump an ambiguous research project on the human. The agent's deliverable for 6.1 is an **Operator Flight Kit**: an executable preflight validator, an interactive runbook, and an evidence validation harness. The human's involvement must be confined to 20–30 minutes of high-value physical execution.

## Sally (UX): Design the human flight kit for zero friction and zero cognitive overload
Running a multi-machine, multi-vendor live demo while concurrently capturing screen recordings, terminal transcripts, and browser viewer state is an ergonomic high-wire act. If the operator has to fiddle with environment variables, debug networking, or guess terminal commands, the demo will fail due to human operational error.

1. **The Preflight Validator (`scripts/rel1-preflight.mjs`):**
   The human should never launch Claude Code or Zcode without knowing both machines are completely ready. The agent must build a preflight script that runs independently on each host (`--role server`, `--role client-claude`, `--role client-zcode`). It must verify:
   - Node and SQLite runtime compatibility (`assertSupportedRuntime`).
   - Server HTTPS reachability over the non-loopback LAN interface (verifying TLS handshake and CA/SAN resolution).
   - Existence and executability of vendor client binaries (`claude`, `zcode`).
   - Distinct Actor keypairs in each machine's respective `PLUGIN_DATA` (preventing accidental self-DMs).
   - Terminal output must use clear, color-coded `[PASS]`/`[FAIL]` indicators with exact remediation instructions on failure.
2. **The Turn-by-Turn Runbook (`docs/rel1-runbook.md`):**
   The runbook must not contain prose or hand-waving. It must be a cockpit checklist:
   - Exact commands to copy/paste into each terminal.
   - Exact initial messages to prompt each agent (e.g. `"Send DM to bob: Hello from Claude Code on Laptop"`).
   - Exact browser steps for the viewer: URL to open, token parameter, and specific visual confirmations to note during the exchange.
3. **The Evidence Packager & Sanitizer (`scripts/rel1-verify-evidence.mjs`):**
   Humans frequently forget an artifact or accidentally commit private keys/tokens. The agent must provide a verification script that checks the evidence directory:
   - Verifies transcript files exist and contain the required message round-trips.
   - Verifies screen recording / browser session artifact is attached and non-zero size.
   - Audits that no private keys, session tokens, or viewer credentials leaked into the transcripts or logs.

## Grumbal (The Adversary): Crush the simulation cop-out and reject release theater
Let us speak plainly about the questions raised:

1. **Question 3 — "Can we simulate REL-1's substance?" ABSOLUTELY NOT.**
   Attempting to automate 6.1 via Docker network namespaces, localhost port bindings, or mocked client harnesses is 100% pure, unadulterated **safety theater**.
   Look at why REL-1 was written into the PRD: *"So that the product's promise is demonstrated, not simulated."* We already have Story 1.8 (two real child processes on one machine), Story 4.8 (remote TLS churn rehearsal), Story 5.3 (LAN interface exposure check), and Story 6.3 (per-vendor packaging smoke tests). Every legitimate automated simulation is *already completed*. The entire purpose of REL-1 is to confront physical network reality: physical NICs, real Wi-Fi/Ethernet packet latency, real OS power/sleep discrepancies between laptop and desktop, and the actual, unmocked Claude Code and Zcode runtimes interacting across real boundaries. Replacing physical demonstration with simulation is the exact cop-out REL-1 exists to forbid.
2. **Question 1 — "Accepted-with-open-items" is a trap:**
   In security and release engineering, "accepted-with-open-items" is a bureaucratic lie designed to declare victory before finishing the job. If the autonomous agent marks Epic 6 "accepted", someone will publish the npm packages or push the git release tag. The epic status is either `IN_PROGRESS` or `BLOCKED_ON_OPERATOR`. Story 6.2 is accepted when the soak passes; Story 6.3 is accepted when packaging and smoke pass; Story 6.1 is blocked on the human. Epic 6 remains open until the physical evidence is audited.
3. **Catching the brief's soak metric flaw:**
   Notice the formulation in the question brief: *"RSS slope over the final four hours ≤2%/s"*. That is a preposterous typo. A memory growth of 2% per second means the process doubles memory every 50 seconds and consumes gigabytes in minutes!
   The canonical PRD and `docs/epics.md` Story 6.2 acceptance criterion is unambiguous:
   `RSS slope over the final four hours ≤ 2% of starting RSS` (i.e. linear regression slope across the final 4-hour window bounded by `0.02 * RSS_0`).
   The autonomous agent must strictly implement the checked-in PRD slope formula, not the nonsense unit slip in the ticket text.
4. **The Candidate Immutability Law:**
   Story 6.3 packages the Release Candidate (RC). Story 6.2 soaks *that exact candidate*. Story 6.1 demonstrates *that exact candidate*.
   If the human runs 6.1 and encounters a bug that requires even a single line of code change in `server/` or `client/`, the candidate is **dead**. The fix requires cutting a new RC, re-running 6.3 validation and smoke tests, and **re-running the entire 8-hour soak (6.2)**. You cannot patch the binary after an 8-hour soak and claim the patched binary was soaked. The hash bindings must be immutable.

---

# Consensus recommendation

## 1. Concrete Execution Order

```
[Phase 1: Story 6.3] Materialize Release Candidate (RC) & Validate
  │  ├── Generate dual packages via scripts/package-release.mjs
  │  ├── Pass `claude plugin validate --strict`
  │  ├── Run client smoke tests against materialized artifact
  │  ├── Measure SM-C1 baseline (5 fresh installs against v0.1 baseline)
  │  └── Freeze candidate: Pin Git commit SHA & artifact SHA-256 hashes
  ▼
[Phase 2: Story 6.2] Formal 8-Hour Endurance Soak (Automated)
  │  ├── Launch formal soak using tests/harness/leak-tracker.mjs against RC server
  │  ├── Enforce: ≥3 sessions, 1 msg/10 s avg + bursts, 32 KiB payloads, hourly reconnects
  │  ├── Verify: Zero message loss, stable FDs (hour > 1), RSS least-squares slope (hours 4–8) ≤ 2% of RSS_0
  │  ├── Record REL-4 idle-footprint counter-metric (0–5 actors)
  │  └── Mark Story 6.2 ACCEPTED (if fail: fix, cut new RC, restart Phase 1)
  ▼
[Phase 3: Story 6.1 Prep] Build Operator Flight Kit & Local Dry-Run (Automated)
  │  ├── Build scripts/rel1-preflight.mjs (read-only environment & reachability validator)
  │  ├── Build docs/rel1-runbook.md (turn-by-turn physical demo checklist)
  │  ├── Build scripts/rel1-verify-evidence.mjs (evidence schema & secret sanitizer)
  │  └── Execute automated local rehearsal to verify tooling integrity
  ▼
[Phase 4: Story 6.1 Execution] Physical Two-Machine Demonstration (Human Gate)
  │  ├── Human executes docs/rel1-runbook.md on Laptop (Claude Code) + Desktop (Zcode)
  │  ├── Observe live authenticated browser viewer (presence updates, <5s freshness, DMs excluded)
  │  ├── Collect evidence into docs/release-evidence/v0.2.0-rel1/
  │  ├── Run scripts/rel1-verify-evidence.mjs
  │  └── Mark Story 6.1 ACCEPTED
  ▼
[Phase 5: Release Closeout] Epic 6 Acceptance & Final Release
     ├── Publish release notes citing cursor reset, SM-C1 baseline, and REL-1 evidence
     ├── Tag v0.2.0
     └── Close Epic 6 as FULLY COMPLETE
```

## 2. What the Autonomous Agent Must Build for Story 6.1

1. **`scripts/rel1-preflight.mjs`**:
   - Single standalone script that accepts `--server <url>`, `--role [server|claude|zcode]`.
   - Validates Node >= 24, SQLite >= 3.51.3, LAN reachability via HTTPS, TLS certificate validity against server origin.
   - Checks that client machines possess distinct Ed25519 Actor keypairs (`fingerprint_A !== fingerprint_B`).
   - Checks that `claude` and `zcode` CLIs exist and respond to `--version`.
2. **`docs/rel1-runbook.md`**:
   - A step-by-step markdown checklist containing exact copy-paste commands, server launch flags, client session prompts, and viewer observation instructions.
3. **`scripts/rel1-verify-evidence.mjs`**:
   - Automated validator that scans `docs/release-evidence/v0.2.0-rel1/`:
     - Checks presence and non-zero size of server logs, Claude Code transcript, Zcode transcript, screen recording video/audio, and browser DOM/network snapshot.
     - Scans all files for accidental leaks of Ed25519 private keys, session tokens, or viewer tokens.
     - Confirms that the candidate hash recorded in the evidence matches the RC hash from Story 6.3/6.2.

## 3. The Human's Personal Checklist

When the autonomous agent completes Phases 1–3, the human executes this checklist:

1. **Network & Server Launch:**
   - Place Laptop and Desktop on the same local network (Wi-Fi or LAN).
   - On the Server host (e.g. Desktop): start the pinned Room Server bound to the LAN IPv4 address with TLS certificates configured.
   - Record the server's LAN HTTPS origin (`https://<lan-ip>:<port>`).
2. **Preflight Execution:**
   - On Laptop: run `node scripts/rel1-preflight.mjs --server https://<lan-ip>:<port> --role claude`.
   - On Desktop: run `node scripts/rel1-preflight.mjs --server https://<lan-ip>:<port> --role zcode`.
   - Confirm both report all green checks and distinct Actor fingerprints.
3. **Viewer & Recording Setup:**
   - Open a real browser (Chrome/Firefox/Safari) to the authenticated viewer: `https://<lan-ip>:<port>/viewer?token=<viewer_token>`.
   - Start full-screen recording capturing the browser window and both client terminal views (or separate synchronized recordings).
4. **Live Exchanges (Primary Demonstration):**
   - In Claude Code on Laptop: send a Direct Message (DM) to Zcode's Actor fingerprint / Chat ID.
   - In Zcode on Desktop: receive the DM and reply in the same direct room.
   - In both Claude Code and Zcode: join the `broadcast` room and post one message each.
5. **Live Viewer Observation & Verification:**
   - Confirm both agents' presence states update to "online" in the viewer's presence list.
   - Confirm Broadcast Room messages appear in the viewer feed within 5 seconds of transmission.
   - **Critical negative check:** Inspect viewer feed and browser DOM to confirm zero Direct Message (DM) text appears.
6. **Evidence Packaging & Verification:**
   - Export terminal transcripts and save the screen recording into `docs/release-evidence/v0.2.0-rel1/`.
   - Run `node scripts/rel1-verify-evidence.mjs`.
   - Commit the verified evidence bundle to git and declare REL-1 complete.

TEAM_DONE epic-6-execution-agy
