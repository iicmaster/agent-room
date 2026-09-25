# codex-advisor[luna] external audit brief — story 1-8

## Mission

Perform an independent, adversarial, **read-only** audit of story 1-8. **Do not modify any file** (no source, test, workflow, documentation, or generated artifact edits). Report only what the files, executed checks, and evidence support; do not fill gaps with plausible guesses.

The contract is `docs/implementation/spec-1-8-first-conversation-integration-checkpoint.md`.

## Change under review (baseline `17def1c7c5caaeef1c5bd5f3da53dbec750d55a8`)

Review every file that differs from the baseline above:

1. `docs/implementation/spec-1-8-first-conversation-integration-checkpoint.md`
2. `docs/implementation/workflows/agent-room-story-build.ts`
3. `tests/integration/first-conversation.test.mjs`

Use the specified baseline to identify the full changed set; call out if the supplied list is not the actual full diff. Do not assume that the presence of a test name implies that it is executed or capable of failing.

## Audit targets

1. **Spec intent contract, clause by clause.** Read the contract and trace each normative obligation, invariant, state transition, prohibition, and recovery rule to the actual production code and its tests. Identify anything the spec requires that is missing, weakened, reordered, or satisfied only nominally.
2. **Store/API invariants the story depends on.** Verify the persistence, cursor/pagination, identity/ownership, atomicity, concurrency, and recovery invariants in the code the story actually depends on, including the semantics under retries, duplicate delivery, and partial failure. Distinguish a proven invariant from an assumption.
3. **Ability of the tests to fail.** Determine whether `tests/integration/first-conversation.test.mjs` is actually executed, whether it uses the real production boundaries rather than tautological/mocked behavior, and whether mutations of production code, the workflow, or the test harness would produce a failure. Identify untested clauses, self-certifying assertions, false-green conditions, and tests that can pass without the story's behavior. Give a concrete falsification/mutation example for each material gap you report.

## Required output format

Return your final result in exactly these sections, in this order:

```
# Verdict
SHIP | FIX-FIRST

# Findings
- [severity] short claim
  Evidence: `path:line` (and, for a check, the exact command and output)
  Why it matters / what to change: concise, actionable explanation

# Checks
- `<exact command>` → <exit status and concise output>
- Explicitly state checks that could not be run, and why.
```

Use `SHIP` only if no material correctness, security, or required-verification gap remains. Use `FIX-FIRST` for any material gap; reserve findings for defects, contract violations, or verification blind spots, not stylistic preferences. Do not reconcile the recommendation into other voices' opinions; give the independent recommendation from this lane. Every finding must cite `file:line` evidence and the relevant part of the contract. Do not claim a check passed unless you ran it in this lane and quote the relevant output.
