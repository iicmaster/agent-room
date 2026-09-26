# Story 1.9 Audit Brief — codex-advisor[luna]

## Role

Independent auditor for Story 1.9 of the agent-room v0.2 build (Epic 1's second blocking gate):
packaging conformance. READ-ONLY: do not modify any file. **Your outbox file is the deliverable** —
write the full audit there; a chat answer alone is not acceptable.

## What changed

- `docs/implementation/spec-1-9-packaging-the-validate-gate.md` — the contract (read its
  `<intent-contract>` and I/O matrix; the matrix rows are the acceptance surface)
- `tests/package.test.mjs` — the entire change (+392 lines of gate coverage on top of the v0.1
  packaging oracles). No production code changed: `scripts/package-release.mjs` was already
  correct; the story exists to make its conformance executable.

## Why this story matters more than its size

`docs/epics.md` makes `claude plugin validate <pkg> --strict` a **blocking gate on every later
structural story in every epic**. A gate that passes for the wrong reason is worse than no gate,
so treat "does this gate actually fail when it should?" as the central question, not a footnote.

## Audit checks (report each PASS / FINDING with file:line evidence)

1. **Spec fidelity** — every intent-contract clause and I/O matrix row implemented AND genuinely
   tested. Name any row whose covering test could not fail.
2. **Gate load-bearingness** — could the gate pass vacuously? Specifically: is the validator
   actually executed (not stubbed, not skipped on absence), is its exit code really checked, is
   the parsed report checked field-by-field rather than by substring, and does the negative test
   genuinely fail the gate (or does it merely assert a fixture shape)?
3. **Negative-test integrity** — the unknown-field test copies the manifest before mutating; verify
   nothing in the real package or repo is mutated, and that the failure it observes comes from the
   validator rather than from the test's own setup erroring.
4. **Escapes and false passes** — env-var overrides, PATH lookups, temp-dir handling, and error
   paths: can a missing/misconfigured `claude` binary, a network-dependent run, or a partial
   package turn the gate green?
5. **Layout coverage** — the `.mcp.json` entrypoint / byte-identity row: does it assert what the
   contract claims (regular non-symlink, byte-identical across both packages and to source)?
6. **Contradictions** — anything contradicting spine AD-8/AD-9, the epics' ACs, or the repo's
   conventions; and any trap for later epics, since every later structural story inherits this gate.

## Output format (write to the outbox)

```markdown
# Story 1.9 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
SHIP | FIX-FIRST

# Findings
- [high|medium|low] <short claim>
  Evidence: <file:line, or the command and its output>
  Why: <what it matters>

# Checks
1..6 — PASS or FINDING reference

TEAM_DONE story-1-9-audit-luna
```

## Hard constraints

- Evidence must cite file:line you actually read, or a command you actually ran with its output.
- Flag any recommendation that conflicts with prior recorded decisions instead of re-deciding them.
- Findings only about this story's change; pre-existing v0.1 packaging behavior is in scope only
  where this change relies on it.
