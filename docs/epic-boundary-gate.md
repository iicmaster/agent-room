# Epic-Boundary Gate

Standing process for every epic in the agent-room v1.0 build. Sourced from the
Epic 1 retrospective (findings F-8, F-9, F-11, F-12, F-13); adopted by operator
directive on 2026-11-16.

## Why this exists

Epic 1 shipped five stories, each verified in isolation by black-box E2E, and
closed as `done`. It also shipped:

- three declared acceptance criteria only partially met (F-8, F-9),
- **five failing tests on the epic tip** (F-12 ×3, F-13 ×2), invisible because
  nobody ran the suite at the boundary,
- one user-visible defect (F-10) that a later story then had to work around.

Every one of those was findable at the boundary and none was found. A green
per-story E2E proves a story works; it does not prove an epic is correct.

## The gate

Run **all four** before starting the next epic. Any red blocks the epic — no
exceptions, no "fix it in the next one".

### 1. Full suite

```sh
node --test --test-reporter=tap 2>&1 | grep -E "^# (pass|fail)"
```

Compare against a **baseline worktree at the previous epic's tag or tip**, not
against the previous run's number. A raw count is not evidence; a *set* diff is:

```sh
git worktree add -q --detach /tmp/ar-baseline <baseline-rev>
(cd /tmp/ar-baseline && node --test --test-reporter=tap 2>&1 \
  | grep "^not ok" | sed 's/^not ok [0-9]* - //' | sort > /tmp/base.txt)
node --test --test-reporter=tap 2>&1 \
  | grep "^not ok" | sed 's/^not ok [0-9]* - //' | sort > /tmp/now.txt
comm -23 /tmp/now.txt /tmp/base.txt   # NEW failures — these are yours
comm -13 /tmp/now.txt /tmp/base.txt   # FIXED — these were the baseline's
git worktree remove --force /tmp/ar-baseline
```

**Every pre-existing failure must be named and owned.** A large pre-existing red
count is not permission to add to it.

Known load-sensitive suites (`churn`, `SM-C1`, `REL-2`, `REL-3`, `release-smoke`,
the multi-server tests) flake under full-suite parallelism. Re-run any suspect in
isolation before classifying it — but never silently drop one.

### 2. Post-hoc AC sweep

Walk every acceptance criterion of every story in the epic against the code, one
by one, with a `file:line` for each. Write the verdict as met / partially met /
unmet. This is what catches F-8 and F-9 — ACs that the story's own E2E never
touched because the E2E tested the path, not the criterion.

Spec text drifts from shipped reality. When they disagree, the **frozen contract
artifacts** (route table, `RESPONSE_FIELD_VOCABULARY`, the AD-8 spine section)
are authoritative, and a test that parses them will fail if you do not amend them
in the same commit.

### 3. Behavior check

Exercise the changed flows end to end and record what you observed. Passing tests
do not substitute: F-10 was reproduced in three commands by an actual `dm`,
against a tip where every relevant test was green.

### 4. Packaging

```sh
TMP="$(mktemp -d /tmp/ar-pkg-XXXXXX)" && rm -rf "$TMP"
node scripts/package-release.mjs --out "$TMP"
claude plugin validate --strict --json "$TMP/agent-room-claude-code"
rm -rf "$TMP"
```

`success: true`, `errors: []`, `warnings: []`, `contents: []`. `ICON_MISSING` in
`directory.findings` is non-blocking advice.

## Then, and only then

Run `/bmad-retrospective` for the epic. Its Phase 2 aggregates and behavior check
overlap this gate deliberately — the gate is the machine check, the retro is the
judgment — but the gate must be green *first*, or the retro spends its budget
discovering broken tests instead of analyzing the epic.

Record the retro in `sprint-status.yaml` via `sprint_status.py update`, then start
the next epic.

## Failure modes this gate is designed to catch

| Mode | Epic 1 example | What catches it |
|---|---|---|
| AC silently unfulfilled | F-9: AC5 listed 8 telemetry names, 4 never shipped | step 2 |
| Partial regression under a new name | F-8: "retire post-auth 429" kept one | step 2 |
| Tests red on the tip | F-12, F-13: 5 failures | step 1 |
| Tests *wrong* but green | F-12: assertions passed by never running | step 1 + baseline set diff |
| Live defect masked by green tests | F-10: `dm` killed its own lease | step 3 |
| Contract drift between spec and code | F-9: spine amendment matched code, epic spec did not | step 2 |
