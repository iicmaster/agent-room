# Story 1.1 Audit Brief — codex-advisor[luna]

## Role

Independent auditor for Story 1.1 of the agent-room v0.2 build: **Runtime foundation & single limits
module** — the load-bearing foundation every later story in every epic binds to. READ-ONLY: do not
modify any file. **Your outbox file is the deliverable** — write the full audit there; a chat answer
alone is not acceptable.

## Context you need

This story was built first, before the external auditor was part of the build loop, so it is the one
story without your review. It is worth auditing precisely because everything else inherits it.

- Contract: `docs/implementation/spec-1-1-runtime-foundation-single-limits-module.md` — read the
  `<intent-contract>` (Intent / Boundaries & Constraints / I/O matrix). The matrix rows are the
  acceptance surface.
- Change: `server/constants.mjs` and `server/keys.mjs` (new at that story); `server/runtime.mjs`,
  `server/mcp-stdio.mjs`, `server/roomd.mjs`, `server/database.mjs`, `package.json` (modified);
  tests `tests/constants.test.mjs`, `tests/keys.test.mjs`, `tests/zero-deps.test.mjs` (new) and
  `tests/runtime.test.mjs`. Later stories extended these files, so read them at HEAD and judge
  whether the FOUNDATION's guarantees still hold now — that is the question, not "what did commit
  df015f6 look like".
- The Auto Run Result and the review triage log are in the spec's own tail sections; the recorded
  first-pass outcome was 21 patches applied, 3 deferred, 12 rejected.

## Why this foundation matters

- The Actor fingerprint is defined here (SHA-256 over the raw 32-byte Ed25519 public key) and every
  later story — presence, DM pair keys, claims, the untrusted envelope, rate budgets, ban — binds
  to it. A wrong or ambiguous definition here is a project-wide defect.
- The keypair file is the durable identity of an installation. Its creation, permission, and
  never-regenerate behavior decide whether an installation can keep its identity across restarts.
- The runtime gates decide whether the process runs at all on a given machine.
- The constants module is the single source for every bound; later stories have been catching and
  fixing literal restatements against it, so judge whether the guard is real now.

## Audit checks (report each PASS / FINDING with file:line evidence)

1. **Spec fidelity** — every intent-contract clause and I/O matrix row implemented AND genuinely
   tested at HEAD. Name any row whose covering test could not fail.
2. **Fingerprint correctness** — raw 32-byte public key extraction (not SPKI-DER), the `sha256:`
   format, hex casing, and that every consumer uses this exact value. Cross-check at least two
   later consumers (presence rows, DM pair keys or the envelope) against the definition here.
3. **Keypair file discipline** — 0600, regular non-symlink, size-bounded, atomic publish, no
   regeneration over invalid material, and what happens if the file is corrupted, truncated, or
   replaced by a symlink between checks. Can two racing starts produce two identities?
4. **Gates** — Node ≥ 24.15 / SQLite ≥ 3.51.3 at every entrypoint, non-zero exit with a
   diagnosable message, and whether a bypass exists (import path, direct launch, test seam).
5. **Constants discipline** — is the "stated once" guard real at HEAD, and does anything outside
   the module restate a limit or an error status? Judge the static check itself: could it pass
   while a restatement exists?
6. **Contradictions & traps** — anything conflicting with spine AD-1/AD-5/AD-8/AD-9, the v0.2
   identity model (D13, FR-3), or AGENTS.md policy; and any latent trap for Epic 2+ that this
   foundation would make expensive to fix later.

## Output format (write to the outbox)

```markdown
# Story 1.1 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
SHIP | FIX-FIRST

# Findings
- [high|medium|low] <short claim>
  Evidence: <file:line, or the command and its output>
  Why: <what it matters>

# Checks
1..6 — PASS or FINDING reference

TEAM_DONE story-1-1-audit-luna
```

## Hard constraints

- Evidence must cite file:line you actually read, or a command you actually ran with its output.
- Flag any recommendation that conflicts with prior recorded decisions instead of re-deciding them.
- Findings only about this story's foundation; later stories' own behavior is in scope only where
  it reveals a defect in the foundation's guarantee.
