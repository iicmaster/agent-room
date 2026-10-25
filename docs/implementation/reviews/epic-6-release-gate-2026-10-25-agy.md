# Final Release-Gate Review — `agent-room` v0.2.0 (`release-gate-v020-agy`)

**Overall Verdict: APPROVE (4–1 split: Winston, John, Vex, and Sally APPROVE; Grumbal records a narrowed conditional dissent on two non-packaged release-body disclosures and live demo-host teardown, while concurring that the frozen candidate `3929cc7` and closing commit `53777cb` are byte-valid to tag and ship).**

- **Task ID:** `release-gate-v020-agy`
- **Repository:** `/Users/ngs/agent-skills/plugins/agent-room` (branch `main`, `HEAD` `53777cb329954169ef9024a8b7be5a0d9e062c15`)
- **Frozen Candidate:** `3929cc74f30f1b0b1f5b989c6e9fbb9d4fed6eba` (`docs/release-evidence/v0.2.0-candidate.json`, version `0.2.0`)
  - Portable package (`agent-room-agent-plugin`): `46` files, `791071` bytes, SHA-256 `3d90129b434b3b7adb9b4b6d8c05ed28b5a8fbf7b07951726c322cc438cf3999`
  - Claude Code package (`agent-room-claude-code`): `46` files, `790931` bytes, SHA-256 `e481c9a46ea5e14865119503e6d327df3993b29a28b325eb9eee9421def2f47b`
- **Mode:** Strictly READ-ONLY repository inspection and in-memory cryptographic verification. No tracked or untracked repository file was modified; this flat outbox file is the sole write.

---

## Seats at the Round-Table (`bmad-party-mode`)

- 🏗️ **Winston** — Systems, Packaging & Provenance Architect (tree-digest determinism, packager boundary, downstream identity-proof mechanics)
- 🔒 **Vex** — Security, Privacy & Public-Exposure Auditor (secret scanning across git history, infrastructure/IP exposure in tracked evidence, trust boundaries)
- 📋 **John** — Product Manager & Governance Custodian (prior ratified decisions, Epic 6 gate closure, retro action-item classification)
- 🎨 **Sally** — Operator UX & Release Communications Reviewer (honesty/completeness of known-limitation disclosures, CLI/packager invocation ergonomics)
- 😤 **Grumbal** — Adversarial Release Gatekeeper (what the release notes omit vs. what the retro records, documentary drift, public-push hygiene)

---

## 1. Independent Verification of the Concrete State & Load-Bearing Reasoning

Before the round-table debate, we verified every premise in the prompt directly against the repository without trusting the summary:

1. **Working Tree & Ancestry (`3929cc7..53777cb`):**
   - `git status --short`: empty (clean working tree).
   - `git rev-parse HEAD`: `53777cb329954169ef9024a8b7be5a0d9e062c15`.
   - `git merge-base --is-ancestor 3929cc74f30f1b0b1f5b989c6e9fbb9d4fed6eba HEAD`: exit `0` (`3929cc7` is an ancestor of `HEAD`, 37 commits behind `53777cb`).
   - *Factual correction to the prompt's summary on commit count and `origin`:* `git rev-list --count HEAD` is **171** commits (not 169), and `remotes/origin/main` already exists in local refs at `46ff0f0` (the v0.1.0 initial commit, 1 commit), leaving `git rev-list --count origin/main..HEAD` = **170** commits to push.
   - `git show --stat 53777cb`: touches **only** three files under `docs/implementation/*` (`docs/implementation/ac-evidence.yaml`, `docs/implementation/spec-6-2-rel-3-the-formal-soak.md`, `docs/implementation/sprint-status.yaml` — 36 insertions, 11 deletions).

2. **The Load-Bearing Packaging & Digest Proof (`scripts/package-release.mjs`):**
   - Inspected `scripts/package-release.mjs:45-46, 223-259`:
     - `portableEntries = ['plugin.json', 'mcp.json', 'server', 'web', 'README.md', 'LICENSE', 'CHANGELOG.md', 'package.json']`
     - `sharedEntries = ['server', 'web', 'README.md', 'LICENSE', 'CHANGELOG.md', 'package.json']` (plus `.claude-plugin/plugin.json` projected from `plugin.json` and static `.mcp.json`).
     - Nothing under `docs/`, `tests/`, `scripts/`, or `HANDOFF.md` is read or copied by the packager.
   - Executed `git diff --stat 3929cc74f30f1b0b1f5b989c6e9fbb9d4fed6eba..HEAD -- plugin.json mcp.json server web README.md LICENSE CHANGELOG.md package.json`: **empty output (0 files changed)** across all 37 commits between `3929cc7` and `53777cb`. `scripts/package-release.mjs` itself is also byte-identical between `3929cc7` and `HEAD`.
   - Executed an **in-memory SHA-256 tree-digest computation** (using the exact `treeDigest` fold from `tests/release-smoke.test.mjs:183-205` and `scripts/package-release.mjs:223-259`, writing zero bytes to disk) against `HEAD` (`53777cb`):
     - `portable`: `{"files":46,"bytes":791071,"sha256":"3d90129b434b3b7adb9b4b6d8c05ed28b5a8fbf7b07951726c322cc438cf3999"}` — **exact match** to `docs/release-evidence/v0.2.0-candidate.json:17-22`.
     - `claude_code`: `{"files":46,"bytes":790931,"sha256":"e481c9a46ea5e14865119503e6d327df3993b29a28b325eb9eee9421def2f47b"}` — **exact match** to `docs/release-evidence/v0.2.0-candidate.json:23-28`.

3. **Gate Verdicts & Sweep Verification:**
   - **Story 6.2 (REL-3 soak attempt 6):** Verified in `docs/release-evidence/v0.2.0-soak-results.{md,json}` and `docs/release-evidence/v0.2.0-soak-attempts/attempt6-3929cc7-*`: `status: "pass"`, `wallMinutes: 724.61`, `identityVerdict: "candidate-exact"` (`3929cc7`), `33725` acked == `33725` readable, `0` duplicates, `0` lost, `fdStability.pass: true` (worst drift `1` inside `±5` over `661` post-baseline samples), `finalWindowRss.pass: true` (OLS `impliedGrowthRatio: 0.005592 <= 0.02`; reported endpoint `growthRatio: -0.018587`). Host window adjudicated `eligible` (`scorer_exit: 0`, `coverage: 1`, `239` in-window samples / `240` valid intervals, `0` gaps, median foreign CPU `0.449 <= 1.345` cores, mean `0.4457 <= 1.576` cores, max foreign processes `4 <= 7`, `MemAvailable >= 6.54 GiB`, `thresholdsDigest` `sha256:253ef296...` matched at launch and scoring). Non-gated diagnostic `retainedState` reported as `rising` (`0.6538%/hour`, `9.2 -> 9.3 MiB` across 46 natural major GCs).
   - **Story 6.1 (REL-1):** Executed `node scripts/rel1-verify-evidence.mjs` -> exit `0` (`16 [PASS]` checks, `0` failures, `SECRETS` clean over 14 files).
   - **AC Sweep:** Executed `node scripts/ac-sweep.mjs --epic N` for Epics `1..6` -> all six epics return `Verdict: clean` (`624 tests in suite`).

---

## 2. The Round-Table Debate

### Topic I — Judging the 6-Step Release Plan & the Load-Bearing Packaging Proof

**🏗️ Winston:** Start with the load-bearing mathematical claim: tagging `53777cb` instead of `3929cc7` cannot alter a single bit of the materialized packages. `scripts/package-release.mjs` (`lines 45-46`) is a strict whitelist copier over eight root entries (`plugin.json`, `mcp.json`, `server`, `web`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`). Our git diff over those eight paths from `3929cc7` to `53777cb` is empty, and our in-memory execution of the packager's transform + `treeDigest` fold over `HEAD` reproduced `3d90129b434b3b7adb9b4b6d8c05ed28b5a8fbf7b07951726c322cc438cf3999` (`791,071` bytes, `46` files) and `e481c9a46ea5e14865119503e6d327df3993b29a28b325eb9eee9421def2f47b` (`790,931` bytes, `46` files) on the first try. Step 4's equality gate will pass deterministically.

**🎨 Sally:** Yes, Winston, the digest math is airtight — but look at the wording of **Step 3** and **Step 5** in the operator's plan:
1. Step 3 says: `node scripts/package-release.mjs --out <two fresh absolute dirs>`. Look at `scripts/package-release.mjs:56-69, 224-225`: the script accepts **one** `--out <fresh-absolute-dir>` argument (passing two arguments after `--out` throws `usage: node scripts/package-release.mjs --out <absolute-dir>`), and a **single** invocation materializes **both** packages as subdirectories (`<out>/agent-room-agent-plugin` and `<out>/agent-room-claude-code`).
2. Step 5 says: *"plus both materialized packages as release assets."* GitHub Release assets are flat archive files (`.tar.gz` or `.zip`), not directory trees. When the operator archives `<out>/agent-room-agent-plugin` and `<out>/agent-room-claude-code` to upload to GitHub Releases:
   - Step 4's tree-digest check must run against the **materialized directories** (`<out>/agent-room-agent-plugin` and `<out>/agent-room-claude-code`).
   - And per our own Retrospective Finding F7 / Action A3 (`docs/implementation/epic-6-retro-2026-10-21.md:79-84, 255`), packaging those directories into `.tar.gz` assets on macOS **must** use `COPYFILE_DISABLE=1 tar ...` so macOS `bsdtar` does not inject 54 `._*` AppleDouble files into the uploaded archives and break a recipient's post-unpack digest check!
   - Also state both the **directory tree digests** (from `v0.2.0-candidate.json`) and the **archive file SHA-256s** in Step 6's release body so users know which hash checks the directory contents vs. the `.tar.gz` download.

**📋 John:** Neither of Sally's points is a reason to refuse the plan; both are exact execution clarifications for Steps 3, 5, and 6 so the operator doesn't trip on CLI arity or macOS `tar` metadata during the release act.

---

### Topic II — Question (a): Do Open Retro Items (`A1`, `A4`, `A10`, `A12`, `A13`) or Anything Else in the Repo Block Shipping?

**📋 John:** I **agree** with the completion audit: none of `A1`, `A4`, `A10`, `A12`, or `A13` blocks shipping v0.2.0, and treating them as blockers would **conflict with prior recorded decisions** in this repository:
- **`A1` (packaged-docs rule):** Look at `docs/implementation/epic-6-retro-2026-10-21.md:253` — its status is explicitly recorded as `"done for v0.2.0 (the third re-cut); the rule is the lasting part"`. We already paid a full candidate re-cut (`dc61332` / `3929cc7`), a 12-hour soak, and a fresh REL-1 run specifically to put `0.2.0 - 2026-10-21` and the Story 6.4 recovery docs into `CHANGELOG.md` and `README.md`. It remains `open` in `sprint-status.yaml` solely as a standing process rule for v0.3+.
- **`A12` & `A13` (baseline-relative quiet-host contract + validated instrument & named scorer):** Look at `epic-6-retro-2026-10-21.md:258-259` and commits `a94e0eb`, `04225c5`, `a0298b4`, `88033f6`: the observer (`scripts/rel1-soak-telemetry.sh`), its on-host self-check (`scripts/rel1-soak-telemetry-check.sh`), the frozen thresholds (`docs/implementation/rel3-quiet-host-thresholds.json`), the 43-fixture scorer (`scripts/rel3-soak-eligibility.mjs`), and the adjudicator (`scripts/rel3-soak-adjudicate.sh`) **were already built, reviewed across four advisor rounds, rehearsed on-host (`rehearsal2-3929cc7`), and used to adjudicate Attempt 6 (`eligible`)**! Like `A1`, they sit in `sprint-status.yaml` as standing methodology rules for future releases, not unfinished v0.2.0 work.
- **`A4` (viewer-freshness observer script in Flight Kit) & `A10` (`rel1-verify-evidence.mjs` recomputes-not-greps):** Both are release-tooling improvements for *future* REL-1 runs. For v0.2.0, the freshness measurement (`0.107 s` local, `0.217 s` cross-machine in `freshness.json`) and the raw evidence bundle were manually audited by two independent advisor lanes (`epic-6-release-gate-codex.md` and `epic-6-release-gate-agy.md`), and `VERIFICATION.md` was rewritten to state the exact provenance of every file.

**😤 Grumbal:** Hold on, John. Don't gloss over the two things in the repo that *did* make me pause on Question (a):
1. **Attempt 6's `retainedState` diagnostic is `rising` at `0.6538%/hour` (`docs/release-evidence/v0.2.0-soak-results.json:120-135`, `9.2 MiB -> 9.3 MiB` over 46 natural major GCs in the 4-hour window).**
2. **Documentary residue across the closing markdown files:**
   - `docs/release-notes-v0.2.md:1-9` still has the header `# Agent Room v0.2 — Release Notes (Release Candidate)` and `Status: **release candidate, frozen** ... v0.2.0 is not tagged or shipped until both of those gates return a verdict`, plus `line 86` still names commit `6d6b45f` in parentheses instead of `3929cc7`.
   - `docs/release-evidence/v0.2.0-candidate.json:5` still has `"status": "frozen-pending-6-2-soak-and-6-1-rel1"`.
   - `docs/implementation/epic-6-completion-audit.md:192-193` and `HANDOFF.md:203-205` still carry a leftover bullet saying *"The packaged CHANGELOG cannot carry the 6.4 entry without voiding the qualification"*, contradicting `epic-6-completion-audit.md:48-50` and `CHANGELOG.md:312-335` where the third re-cut *did* add the 6.4 entry.
   - `docs/implementation/epic-6-retro-2026-10-21.md:4,18` still has `verdict: in-progress-pending-the-8-hour-soak` in the YAML frontmatter while `line 269` says `Epic 6 is COMPLETE`.
   - `README.md:197` (inside the frozen package) still has a one-line Epic 1 fossil: *"The read-only web viewer is not part of the v0.2 tool surface yet (Epic 5)."*

**🏗️ Winston:** Grumbal, let's separate what is governed by pre-registration from what is cosmetic prose:
- On **`retainedState: rising` (`0.6538%/hour`)**: the owner-ratified pre-registration (`docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md`) and both amendment-gate reviews (`epic-6-amendment-gate-codex.md:39`, `epic-6-amendment-gate-claude.md`) explicitly bound the release gate to FR-13's 4-hour RSS OLS slope (`+0.56% <= 2.0%`, while endpoint RSS *fell* `-1.86%`) and ruled that a rising post-GC heap reading (`+100 KiB` over 4 hours, `9.2 -> 9.3 MiB`) is **reported, never gated**, with a mandatory disposition: *ship on the ratified RSS gate, carry the reachable-heap observation to v0.3, and make no "leak-free" claim*. Refusing the release on `retainedState: rising` would **violate the pre-registered decision tree** after the run finished.
- On **`README.md:197`**: touching `README.md` touches a packaged input, which under the Candidate Immutability Law (`docs/release-evidence/v0.2.0-candidate.json:6`) would void candidate `3929cc7` and destroy 12 hours of Attempt 6 soak + physical REL-1 over a one-line bullet when `CHANGELOG.md:29-48` and `docs/self-hosting-deployment.md` already document the viewer in full. **Flagged:** any recommendation to edit `README.md` now would conflict with the Candidate Immutability Law.
- And on `v0.2.0-candidate.json:5` (`"status": "frozen-pending-6-2-soak-and-6-1-rel1"`): that file is the **freeze record created at candidate birth**, and `scripts/rel1-verify-evidence.mjs:190-217` compares `docs/release-evidence/v0.2.0-rel1/candidate.json` against `docs/release-evidence/v0.2.0-candidate.json`. Leaving the freeze record untouched preserves the exact freeze snapshot that REL-1 and REL-3 pinned.

**😤 Grumbal:** Fine — I accept that `retainedState: rising` is governed by the pre-registered decision tree and that touching `README.md` or `v0.2.0-candidate.json` would violate candidate immutability. And I agree `A1`, `A4`, `A10`, `A12`, and `A13` do not block shipping.

---

### Topic III — Question (b): Are the Five v0.3 Runtime Items (`A5`–`A9`) Disclosed Honestly and Sufficiently in the Release Notes?

**🎨 Sally:** Here is a concrete fact check of `docs/release-notes-v0.2.md` (`lines 128-165`), `README.md` (`lines 67-86`), and `CHANGELOG.md` (`lines 312-335`) against the five v0.3 runtime items (`A5`–`A9`):

| Item | Description | In `docs/release-notes-v0.2.md`? | In Packaged `README.md` / `CHANGELOG.md`? | Honest & Sufficient? |
|---|---|---|---|---|
| **A5** | `AuthzStage` fence runs before request body stream is read on body-carrying routes (`POST/PATCH /api/session`) | **Yes** (`lines 148-153`) | **Yes** (`README.md:75-80`, `CHANGELOG.md:329-333`) | **Yes** — clear, accurate, explains why dead-session takeover is unaffected |
| **A6** | Takeover intent binds to whoever holds the name *at execution time*, not an observed incumbent conflict ticket | **Yes** (`lines 153-155`) | In `spec-6-4:55` (not in `README`/`CHANGELOG`) | **Yes** in release notes |
| **A7** | `superseded` fence map is bounded at `1,000` entries (`SESSIONS_MAX`), so `1,001` supersessions can evict a still-admitted predecessor | **NO — omitted from `docs/release-notes-v0.2.md`** (present in `epic-6-completion-audit.md:176-177`, `epic-6-retro:262`, `HANDOFF.md:238`) | **No** | **Gap in release notes** |
| **A8** | Orderly-exit `input.once('close')` loses the race when a one-shot vendor CLI (`zcode -p`) kills its MCP child before remote `DELETE /api/session` finishes | **Yes** (`lines 130-134`) | **Yes** (`README.md:83-85`) | **Yes** — directly cites the REL-1 finding and points to `session replace` |
| **A9** | Shutdown-during-initial-bind race (`stdin` closes while first auth/bind is in flight, before token is assigned) | **NO — omitted from `docs/release-notes-v0.2.md`** (present in `epic-6-completion-audit.md:177-178`, `epic-6-retro:264`, `HANDOFF.md:240`) | **No** | **Gap in release notes** |
| *(+ TTY)* | `isTTY` prompt on `session replace` stops accidental pipes, not a shell-capable agent allocating a PTY (`script -q`) | **Yes** (`lines 155-158`) | **Yes** (`README.md:69-74`, `CHANGELOG.md:333-335`) | **Yes** |

**😤 Grumbal:** Look at that table! The prompt states: *"The five v0.3 runtime items (A5–A9, the session-fence family) are disclosed in the release notes as known limitations. Is the disclosure honest and sufficient?"*
 We checked the file! `docs/release-notes-v0.2.md` (`lines 130-158`) discloses **three** of the five (`A5`, `A6`, `A8`) plus the `isTTY` PTY caveat and the lack of automatic crash recovery (`A2`). It **omits `A7`** (the 1,000-entry fence eviction cap) and **omits `A9`** (the shutdown-during-initial-bind race), and it also omits the Attempt 6 `retainedState: rising` (`0.65%/hour`) diagnostic note that `epic-6-completion-audit.md:23-29` carries!

**📋 John:** Let's keep perspective on severity, Grumbal:
1. The three disclosures that *are* in `docs/release-notes-v0.2.md` (`A5`, `A6`, `A8`, plus the PTY caveat) are remarkably candid — they don't spin or minimize the behavior, and they cover every scenario an operator actually encounters in the field (especially `A8`, the one-shot CLI squat). `A7` requires 1,001 session takeovers while a single request's body stream is paused mid-flight, and `A9` requires `stdin` closing during the sub-second initial bind handshake.
2. More importantly, look at **Step 5** of the plan: *"Publish a GitHub release v0.2.0 on origin with: the release-notes text, the frozen candidate record, the soak results (attempt 6) and the REL-1 evidence bundle, plus both materialized packages as release assets."* The GitHub Release body is external to the git tag and external to the packaged bytes! When assembling the GitHub Release body text in Step 5, the operator can (and should) flip the top status line from `release candidate, frozen` to `released (both qualification gates passed)` and append two one-line bullets for `A7`, `A9`, and the non-gated `retainedState` observation — with **zero** commits and **zero** impact on the tag or package digests.

**🎨 Sally:** I agree with John on the mechanism, and I agree with Grumbal that the GitHub Release body in Step 5 should include `A7` and `A9` (and update the top RC banner) so a reader of the GitHub Release page gets all five items (`A5`–`A9`) without having to dig into `docs/implementation/epic-6-completion-audit.md`.

---

### Topic IV — Question (c): Public Push of All History — Secrets, `.vendor-lab`, and Infrastructure Metadata

**🔒 Vex:** I scanned all **336 tracked files** (including binary blobs via Latin-1 window scanning) and the **entire 171-commit git history** (`git log --all -p`) for private keys, session tokens, invite tokens, viewer cookies, bearer headers, API keys, and SQLite files. Here is the exact forensic inventory:

1. **Cryptographic Keys, Credentials & Tokens — CLEAN (0 leaks in tracked tree or git history):**
   - `-----BEGIN ... PRIVATE KEY-----`: appears **only** in 4 test files (`tests/remote-client.test.mjs`, `tests/self-hosting-deployment.test.mjs`, `tests/viewer-exposure.test.mjs`, `tests/drills/remote-dress-rehearsal.test.mjs`) as ephemeral self-signed test fixtures, plus the regex literal in `scripts/rel1-verify-evidence.mjs`.
   - `session_token`, `ar_inv1_`, `agent_room_viewer=`: zero real values anywhere in tracked files or git history (only `agent_room_viewer=not-a-real-cookie-value-at-all-00000000000` in `tests/viewer-exposure-driver.mjs`).
   - Cloud/vendor keys (`sk-...`, `ghp_...`, `AIza...`, `xox...`, `Authorization: Bearer ...`): **zero** occurrences in tracked files or git history.
   - `.vendor-lab/`, `.soak-world/`, `.candidate-packages/`, `.candidate-checkout/`, root `.mailbox-out/`, and root `.tmux-teams/` are all `.gitignore`d and were **never committed in any of the 171 commits**. While `scripts/three-vendor-lab.sh:115,129` symlinks `~/.codex/auth.json` and `~/.gemini/*` into `.vendor-lab/` at runtime, only `docs/release-evidence/v0.2.0-three-vendor/{README.md,VERIFICATION.md,room-state.json,transcript-*.txt}` were ever committed — none of the symlinked auth files ever entered git.

2. **What IS in the Tracked Tree and Commit History (Infrastructure & Operator Metadata):**
   - **Two public IPv4 addresses and ports of operator hosts:**
     - `43.229.78.103` (`ngs-2`, ports `:18443` and `:18444`, Ubuntu 24.04, Docker container `/agroom-rel1-64b`, host paths `/home/forge/rel1/server-key.pem`, `/home/forge/rel1-64b-data`) in `docs/release-evidence/v0.2.0-rel1/{server.log,preflight-*.json,takeover-*,transcript-zcode.txt,viewer-session.md,VERIFICATION.md}` and `docs/release-evidence/v0.2.0-cross-machine/*`.
     - `43.229.78.155` (`ngs-staging` / `9router`, Linux `5.14.0-642.el9.x86_64`, kernel `boot_id 3bef85f2-56ae-4007-9a72-e5ef813b97d7`, foreign process list showing `/usr/local/bin/9router`, `zai-mcp-server`, `playwright-mcp`, `codex`, and `/root/rel1-soak6/...`) in `HANDOFF.md:90` (`ssh 43.229.78.155`) and `docs/release-evidence/v0.2.0-quiet-host/*census.txt` / `v0.2.0-soak-attempts/*`.
   - **Tracked early review outboxes:** `docs/epics-review/.mailbox-out/*` (5 files) and `docs/prds/prd-agent-room-2026-09-20/.mailbox-out/*` (2 files) were committed in `8e95118`. They contain architecture/PRD round-table prose and `/Users/ngs/agent-skills/plugins/agent-room/...` paths — no credentials.
   - **Local workstation & author metadata:** hostname `NSG-Mac-mini`, username path `/Users/ngs/...`, `~/.zcode/v2/provider_config.json` path references in `HANDOFF.md:267-274`, and git commit author `Warawut Meesupa <nextgensolution.th@gmail.com>`.

**😤 Grumbal:** Look at `HANDOFF.md:273-274`:
> *"The demo hosts still carry state: the server container `agroom-rel1-64` on ngs-2 (port 18444, data dir `/home/forge/rel1-64-data`) and the installed package + client under `/root/rel1-claude/` on ngs-staging."*
If you push `HANDOFF.md` and `docs/release-evidence/v0.2.0-rel1/server.log` to a **public** GitHub repository (`https://github.com/iicmaster/agent-room`) while `agroom-rel1-64` / `agroom-rel1-64b` is **still running and listening on `https://43.229.78.103:18444`**, you are publishing a live target IP + port + container mount layout to the public internet! Even though `agent-room` requires invite-gated enrollment or a viewer token, leaving a temporary demo container exposed on a public IP after publishing its address and logs is poor operational hygiene.

**🔒 Vex:** On that point Grumbal and I agree completely, and notice the beauty of the fix: **tearing down the demo Docker container on `ngs-2` (`43.229.78.103:18444`) and closing port `18443`/`18444` on the host firewall is an external infrastructure action — it requires zero git commits and changes nothing in the repository!** As for the historical IP strings (`43.229.78.103`, `43.229.78.155`), hostnames (`ngs-2`, `ngs-staging`, `NSG-Mac-mini`), and `/Users/ngs` paths in `docs/release-evidence/`: once the demo listener is stopped, they are benign forensic provenance proving the two-machine run was real (and scrubbing them from `docs/release-evidence/` would require rewriting git history across `18ea145`..`53777cb`). Therefore: **nothing in the tracked tree requires a repo edit or history rewrite before pushing, provided the operator stops the live demo container on `43.229.78.103:18444` and accepts public visibility of those two host IPs/hostnames.**

---

### Topic V — Question (d): Does Tagging a Docs-Ahead Commit (`53777cb` after `3929cc7`) Break Any Downstream Identity Proof?

**🏗️ Winston:** I traced every downstream script and test in the repository that reads `docs/release-evidence/v0.2.0-candidate.json` or inspects git/package state. Here is the exact mechanical behavior of all four downstream consumers when `v0.2.0` is tagged at `53777cb` (`HEAD`) while `v0.2.0-candidate.json` pins `source.git_commit: "3929cc74f30f1b0b1f5b989c6e9fbb9d4fed6eba"`:

1. **`scripts/package-release.mjs` & `tests/release-smoke.test.mjs`:**
   - Neither file invokes `git` or reads `docs/implementation/*`. They operate strictly on the eight packaged input paths and their materialized output directories.
   - **Result:** **0 impact** — byte-identical materialization and green smoke tests.

2. **`scripts/rel1-verify-evidence.mjs` (`lines 190-217`, check `CAND`):**
   - Compares `docs/release-evidence/v0.2.0-rel1/candidate.json` against `docs/release-evidence/v0.2.0-candidate.json` (`source.git_commit` and `artifacts.{portable,claude_code}.sha256`). It never runs `git rev-parse HEAD`.
   - **Result:** **0 impact** — `[PASS] CAND`, exit `0` (verified live during this review).

3. **`tests/soak/rel3-soak.mjs` (`lines 410-512`, `establishCandidateIdentity` & `runtimeIdentityProof`):**
   - First (`lines 464-483`), `establishCandidateIdentity` materializes both packages via `scripts/package-release.mjs` and compares `actual.{portable,claude_code}.sha256` against `frozen.{portable,claude_code}.sha256`. Because zero packaged inputs changed between `3929cc7` and `53777cb`, `exactMatch` is **`true`**, so the soak runner immediately returns **`identityVerdict: 'candidate-exact'`** (recording `candidateCommit: '3929cc7...'` and `launchHead: '53777cb...'`). Indeed, Attempt 6 itself ran at `launchHead: '5c4d244...'` (a docs/tooling commit ahead of `3929cc7`) and recorded `identityVerdict: 'candidate-exact'` (`docs/release-evidence/v0.2.0-soak-results.json:26-29`)!
   - Second, even if the fallback `runtimeIdentityProof` (`lines 410-450`) were ever invoked, it checks `git merge-base --is-ancestor <candidateCommit> HEAD` (`true`) and `git diff --name-only <candidateCommit> HEAD -- server web plugin.json mcp.json package.json README.md LICENSE CHANGELOG.md` (empty).
   - **Result:** **0 impact** — returns `'candidate-exact'`.

4. **`scripts/rel1-preflight.mjs` (`lines 371-407` and `478-524`):**
   - **Client roles (`--role claude` / `--role zcode`, `lines 478-524`):** Gating check `CA` (`gating: true`) computes `treeDigest(root)` over `--plugin-root` and compares `sha256 === expected.sha256`. It never checks `git rev-parse HEAD`. **Result:** `[PASS] CA`, exit `0`.
   - **Server role (`--role server`, `lines 371-407`):** Check `PV` (`candidate provenance`) runs `git -C repoRoot rev-parse HEAD` (`line 381`) and compares `head === expectedCommit`. At `53777cb`, `head !== expectedCommit`, so `PV` prints:
     `[WARN] PV candidate provenance (report only — does not gate)`
     `       candidate v0.2.0 frozen at commit 3929cc7...; MISMATCH: this checkout's HEAD is 53777cb..., the frozen commit is 3929cc7... — verify you are demonstrating the pinned tree`
     Because `PV` has `gating: false` (`line 407`) and always returns `CHECK.warn`, `rel1-preflight.mjs --role server` **still passes all gating checks and exits `0` (`all_pass: true`)**.
   - **Result:** Nothing breaks or fails; only the non-gating `[WARN] PV` informational line on `--role server` notes the commit offset between the freeze commit (`3929cc7`) and the tagged closeout commit (`53777cb`).

---

## 3. Summary Answers to Every Question

- **THE PLAN (Steps 1–6):** **APPROVE**, with two operational execution notes that require zero repo changes:
  1. In **Step 3**, run `node scripts/package-release.mjs --out <one-fresh-absolute-dir>` (the script takes **one** `--out` parent directory and creates both `<dir>/agent-room-agent-plugin` and `<dir>/agent-room-claude-code` inside it; passing two paths to `--out` is a CLI usage error).
  2. In **Step 5 & Step 6**, compute and verify the frozen tree digests (`3d90129b…` and `e481c9a4…`) on the materialized directories in Step 4; then when archiving those two directories into `.tar.gz` / `.zip` files for GitHub Release asset upload in Step 5, set `COPYFILE_DISABLE=1` on macOS so AppleDouble `._*` files are not injected into the release tarballs (retro F7/A3), and list both the candidate tree digests and the archive SHA-256 checksums in the Step 6 release body.
- **LOAD-BEARING REASONING:** **VERIFIED.** `53777cb` touches only `docs/implementation/{ac-evidence.yaml,spec-6-2-rel-3-the-formal-soak.md,sprint-status.yaml}`; `scripts/package-release.mjs` copies only `plugin.json`, `mcp.json`, `server`, `web`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`; `git diff --stat 3929cc7..HEAD` over those eight inputs is empty; and our in-memory digest calculation over `HEAD` reproduced both frozen SHA-256 digests (`3d90129b434b3b7adb9b4b6d8c05ed28b5a8fbf7b07951726c322cc438cf3999` and `e481c9a46ea5e14865119503e6d327df3993b29a28b325eb9eee9421def2f47b`) byte-for-byte.
- **Question (a) — Blockers & open `"release"` retro items (`A1`, `A4`, `A10`, `A12`, `A13`):** **AGREE with the completion audit — nothing blocks shipping.** `A1`, `A12`, and `A13` are already implemented and satisfied for v0.2.0 (they remain `open` in `sprint-status.yaml` as standing rules for future releases); `A4` and `A10` are future Flight Kit automation items whose v0.2.0 substance was already satisfied by the manual two-lane evidence audits and `VERIFICATION.md` disclosures; and Attempt 6's `retainedState: rising` (`0.6538%/hour`) is governed by the pre-registered decision tree (reported, non-gated, carried to v0.3 without a leak-free claim).
- **Question (b) — Disclosure of the five v0.3 runtime items (`A5`–`A9`) in `docs/release-notes-v0.2.md`:** **Honest and accurate for the three operator-facing items included (`A5`, `A6`, `A8` + the `isTTY` PTY caveat), but incomplete on count:** `docs/release-notes-v0.2.md` omits **`A7`** (the 1,000-entry `superseded` fence retention bound) and **`A9`** (the `stdin`-close-during-initial-bind race), which are documented in `epic-6-completion-audit.md:174-180` and `HANDOFF.md:234-240`, and its top banner still reads `Status: release candidate, frozen`. Both can be supplemented directly in the GitHub Release body text during Step 5 without touching the repo or tag.
- **Question (c) — Public push of all history (171 commits):** **Zero secret leaks** across all 336 tracked files and all 171 commits (`0` real private keys, `0` session tokens, `0` `ar_inv1_` invite tokens, `0` real viewer cookies, `0` API keys; `.vendor-lab/` was never committed). **However**, tracked evidence files and `HANDOFF.md` contain the public IPv4 addresses and hostnames of the test infrastructure (`43.229.78.103` / `ngs-2` port `18443`/`18444` and `43.229.78.155` / `ngs-staging`). Before pushing to the public repo, stop the live demo container (`agroom-rel1-64` / `agroom-rel1-64b`) on `43.229.78.103:18444` (referenced as still running in `HANDOFF.md:273-274`).
- **Question (d) — Tagging a docs-ahead commit (`53777cb` vs `3929cc7`):** **Nothing gating breaks downstream.** `package-release.mjs`, `rel1-verify-evidence.mjs`, `rel1-preflight.mjs` (client roles `claude`/`zcode`), and `rel3-soak.mjs` (`establishCandidateIdentity`) all compare packaged bytes and return `candidate-exact` / `[PASS]`. The only place in the repo that notices `HEAD !== 3929cc7` is check `PV` in `scripts/rel1-preflight.mjs --role server` (`lines 381-386`), which is explicitly non-gating (`gating: false`, prints `[WARN] PV ... (report only — does not gate)`, exits `0`).
- **Flagged Conflicts with Prior Recorded Decisions:**
  - Any recommendation to edit `README.md`, `CHANGELOG.md`, `server/`, `web/`, or `plugin.json` before tagging would **violate the Candidate Immutability Law** (`docs/release-evidence/v0.2.0-candidate.json:6`).
  - Any recommendation to block v0.2.0 on `A5`–`A9` or on Attempt 6's non-gated `retainedState: rising` (`0.6538%/hour`) diagnostic would **violate the ratified Story 6.4 scope decision** (`HANDOFF.md:224-227`) and **the owner-ratified REL-3 pre-registration decision tree** (`docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md`).

---

## 4. What Was Verified vs. What Could Not Be Verified

- **Verified directly in this review:**
  - Clean git status, `HEAD` `53777cb`, ancestry from `3929cc7`, full diff of `53777cb` (`docs/implementation/*` only), empty diff across all 8 packaged inputs (`plugin.json`, `mcp.json`, `server`, `web`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`) and `scripts/package-release.mjs` between `3929cc7` and `HEAD`.
  - In-memory execution of `scripts/package-release.mjs` artifact construction + `treeDigest` fold over `HEAD`, confirming exact SHA-256 match for both `portable` (`3d90129b434b3b7adb9b4b6d8c05ed28b5a8fbf7b07951726c322cc438cf3999`, 46 files, 791,071 bytes) and `claude_code` (`e481c9a46ea5e14865119503e6d327df3993b29a28b325eb9eee9421def2f47b`, 46 files, 790,931 bytes).
  - Live execution of `node scripts/rel1-verify-evidence.mjs` (exit `0`, 16/16 `[PASS]`) and `node scripts/ac-sweep.mjs --epic 1..6` (all 6 epics `Verdict: clean`, 624 tests).
  - Full-repo and full-git-history (`171` commits, `336` tracked files) secret & IP/hostname scan.
  - Code-level trace of `scripts/package-release.mjs`, `scripts/rel1-preflight.mjs`, `scripts/rel1-verify-evidence.mjs`, and `tests/soak/rel3-soak.mjs`.
- **Not verified in this review (stated plainly):**
  - Did not run `node scripts/package-release.mjs --out ...` to disk (to honor the strict no-filesystem-writes rule outside `.mailbox-out/release-gate-v020-agy`; in-memory digest verification was used instead).
  - Did not re-run the full `node --test --test-concurrency=1 --test-timeout=600000` test suite or `claude plugin validate --strict` during this turn.
  - Could not verify whether the remote Docker container `agroom-rel1-64` / `agroom-rel1-64b` on `43.229.78.103:18444` (`ngs-2`) is still live right now or whether the GitHub remote `https://github.com/iicmaster/agent-room` is reachable with push credentials.

---

## 5. Each Voice's Own Bottom Line

- 🏗️ **Winston (Systems, Packaging & Provenance Architect):**
  > **APPROVE.** The packaging boundary in `scripts/package-release.mjs` is hermetically isolated from `docs/implementation/*`, the packaged inputs have zero diff between `3929cc7` and `53777cb`, and our in-memory SHA-256 fold over `HEAD` matches both frozen candidate digests bit-for-bit. Tagging `53777cb` breaks zero downstream gates (`rel3-soak.mjs` still resolves to `'candidate-exact'`; `rel1-preflight.mjs --role server` emits only a non-gating `[WARN] PV`). Just remember Step 3 takes **one** `--out <fresh-abs-dir>` path and creates both packages inside it.

- 🔒 **Vex (Security, Privacy & Public-Exposure Auditor):**
  > **APPROVE, with one operational pre-push action on `ngs-2`.** All 336 tracked files and all 171 commits are 100% free of private keys, session tokens, `ar_inv1_` invite tokens, viewer cookies, and cloud credentials, and `.vendor-lab/` never entered git history. However, `docs/release-evidence/` and `HANDOFF.md` publish the public IPs `43.229.78.103` (`ngs-2:18444`) and `43.229.78.155` (`ngs-staging`). Stop the temporary REL-1 Docker container on `43.229.78.103:18444` before pushing its address and logs to a public GitHub repo.

- 📋 **John (Product Manager & Governance Custodian):**
  > **APPROVE.** Every precondition set by the PRD, the Epic 6 execution rulings, the release-gate reviews, and the owner-ratified REL-3 amendment has been met and verified (`attempt 6` passed at `724.61 min` with `eligible` host adjudication; REL-1 verified; all 6 epic AC sweeps `clean`). `A1`, `A4`, `A10`, `A12`, and `A13` are rightly recorded as non-blocking process/tooling items, and `A5`–`A9` plus the `retainedState` observation belong to v0.3 per our settled decisions. Ship v0.2.0.

- 🎨 **Sally (Operator UX & Release Communications Reviewer):**
  > **APPROVE.** When executing Step 5 (publishing the GitHub Release on `origin`), make three zero-commit polish adjustments to the GitHub Release body text: (1) update the pasted header from `Status: release candidate, frozen` to reflect that both gates passed, (2) add the two missing v0.3 runtime bullets (`A7` 1,000-entry fence cap and `A9` shutdown-during-initial-bind race) alongside `A5`, `A6`, and `A8`, and (3) use `COPYFILE_DISABLE=1` when tarring the materialized package directories on macOS so the uploaded release assets stay free of `._*` AppleDouble files.

- 😤 **Grumbal (Adversarial Release Gatekeeper):**
  > **CONDITIONAL DISSENT ON STEP 5'S RELEASE BODY & LIVE HOST TEARDOWN (CONCUR ON TAGGING `53777cb` AND SHIPPING THE `3929cc7` BYTES).** I do not block the candidate bytes or the tag on `53777cb` — the digest proof holds and Attempt 6 earned its pass under the frozen rules. My refusal is aimed solely at pasting `docs/release-notes-v0.2.md` verbatim into the GitHub Release without adding `A7`, `A9`, and Attempt 6's `retainedState: rising (0.65%/h)` finding (and fixing the stale `release candidate, frozen` / `6d6b45f` strings in the pasted release body), and at pushing `43.229.78.103:18444` to a public repo before killing the `agroom-rel1-64` container on `ngs-2`. Do both of those in the release act, and the gate is clean.

TEAM_DONE release-gate-v020-agy
