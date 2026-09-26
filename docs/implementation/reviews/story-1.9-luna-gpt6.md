# Story 1.9 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
FIX-FIRST

# Findings
- [high] `TMPDIR` can put the package and negative copy inside the repository, where the gate can still pass.
  Evidence: `tests/package.test.mjs:404-410,546-549` creates parents under `tmpdir()` without checking their resolved location; `scripts/package-release.mjs:98-113` rejects outputs containing the source or inside `server/` and `web/`, but not other checkout paths; `spec-1-9-packaging-the-validate-gate.md:26` requires all gate materialization outside the repository.
  Why: With `TMPDIR` set to the repository root or an unguarded subdirectory, the packager accepts the temporary output and the validator runs there. `t.after` later removes it, but this violates the explicit no-in-repository-validation rule and can still go green.
- [high] Pairwise snapshots can bless two equally incomplete runtime trees.
  Evidence: `tests/package.test.mjs:236-245` compares only portable and Claude snapshots; source equality is asserted separately only for the packaged entrypoint at `:621-630`. The validator gap is stated at `:600-603`.
  Why: If a non-entrypoint runtime file is missing from both generated packages, their snapshots still match and the manifest-only validator does not inspect that omission. The blocking gate can pass with an incomplete pair. Compare shared package files with the source tree or otherwise pin the complete expected key set.
- [medium] The resolver does not establish that the selected executable is Claude Code.
  Evidence: `tests/package.test.mjs:334-363` accepts any executable from `AGENT_ROOM_CLAUDE_BIN` or `PATH`; `:365-370,690-695` only requires a non-empty `--version` string. The contract requires the real binary at `spec-1-9-packaging-the-validate-gate.md:26,30`.
  Why: Missing and non-executable paths fail closed, but an executable shim can print the expected version and positive/negative JSON reports. The test invokes the selected path directly, yet relies on host configuration to make that path the real validator.
- [low] Validator timeout/spawn failures omit the already-known version context.
  Evidence: `tests/package.test.mjs:491-496` obtains the version before validation; `runClaudePluginValidate` rethrows errors without context at `:441-454`. The contract requires the version in gate failure messages at `spec-1-9-packaging-the-validate-gate.md:26,48`.
  Why: A timeout or spawn failure after version discovery fails the test, but its raw error message does not include the version. This is diagnostic only; it does not make the gate green.

# Checks
1 — FINDING F1, F2, F4. The matrix rows have fail-capable assertions; the temp-location, source-completeness, and timeout-diagnostic clauses remain incomplete as described.
2 — PASS with F3 caveat. Source inspection confirms direct `execFile` invocation with `--strict --json`, explicit exit-code and field-by-field report assertions (`tests/package.test.mjs:441-455,491-534`). Missing or non-executable binaries throw rather than skip (`:343-363,663-688`). The negative test asserts the validator's non-zero exit and field-specific warning, not merely fixture shape (`:536-582`). Tests were not run in this read-only audit.
3 — PASS. The manifest is copied into a second temp parent before mutation (`tests/package.test.mjs:540-554`); the test checks source bytes and the original materialized manifest afterward (`:585-594`). The warning path/message assertions tie failure to the injected key (`:571-582`).
4 — FINDING F1, F2, F3, F4. Missing/non-executable paths fail closed; timeout is bounded. The harness has no network fallback, but network behavior inside the external CLI was not verified. The `tmpdir()` containment and executable-identity gaps are above.
5 — PASS. `.mcp.json` is checked against the exact expected shape and entrypoint args; `server/mcp-stdio.mjs` is asserted regular, non-symlink, and byte-identical in both packages and to source (`tests/package.test.mjs:604-630`).
6 — FINDING F1, F2, F3. No AD-8/AD-9 wire-contract conflict is visible (`ARCHITECTURE-SPINE.md:102-119`). The gate is wired into the default `node --test` command (`package.json:12-15`) and is declared blocking for later structural stories (`docs/epics.md:302-303`, `docs/implementation/epic-1-context.md:60`). Those stories inherit the temp-path, incomplete-pair, and trusted-validator assumptions.

Panel pressure test:
- John (PM): FIX-FIRST; a universal downstream gate must not validate inside the checkout or accept a shared omission.
- Sally (UX): SHIP if the host temp path and validator are trusted; the stated package-to-package assertions are useful and failures remain actionable.
- Grumbal (adversary): FIX-FIRST; both the location override and executable override can defeat the claimed boundary.

TEAM_DONE story-1-9-audit-luna
