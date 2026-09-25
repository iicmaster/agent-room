# Verdict
FIX-FIRST

# Findings
- [high] The workflow can fail open on the Luna review and does not parse this lane's required finding format.
  Evidence: `docs/implementation/workflows/agent-room-story-build.ts:376` converts an unreadable outbox to empty text; `:377-387` then maps text without `FIX-FIRST` to `SHIP`. Its finding parser at `:380` accepts only `[blocker|warning|nit] ... — ...`, while this lane requires `- [severity] short claim` plus separate Evidence/Why lines in `docs/implementation/reviews/story-1-8-luna-brief.md:33-40`. The structured list enters triage at `:395-409`; the finalizer proceeds at `:443-455` without a verdict guard. This can bypass the story's required verification gate at `docs/implementation/spec-1-8-first-conversation-integration-checkpoint.md:112-119`.
  Why it matters / what to change: A missing report becomes SHIP, and a valid FIX-FIRST report can produce zero structured findings. Require a regular flat file for the matching task, validate its terminal marker and sections, fail closed on missing/blocked/unrecognized output, and prevent finalization while FIX-FIRST findings remain unresolved.

- [high] Review scope is based on HEAD after implementation, so a commit can remove implementation files from review.
  Evidence: the contract pins baseline `17def1c7c5caaeef1c5bd5f3da53dbec750d55a8` at `docs/implementation/spec-1-8-first-conversation-integration-checkpoint.md:6`. The workflow records `HEAD` only after implementation and tests at `docs/implementation/workflows/agent-room-story-build.ts:273`, then derives reviewer paths from that revision at `:280-285`; the implementer prompt at `:242-247` does not prohibit commits.
  Why it matters / what to change: If the implementer commits before returning, the new HEAD becomes the baseline and those tracked changes disappear from the reviewer list. Capture and use the spec's pinned baseline before implementation, and reject a mismatched baseline.

- [medium] The first-conversation test does not prove Bob's read was pending before Alice sent.
  Evidence: the contract requires a long-poll wake-up at `docs/implementation/spec-1-8-first-conversation-integration-checkpoint.md:44` and explicitly rejects a result that arrives only at the deadline at `:106`. The test starts Bob's call, sleeps 150 ms, and sends Alice's message at `tests/integration/first-conversation.test.mjs:535-543`, but its timing oracle at `:559-565` checks only that the result is less than 2,000 ms after the send. With a 2,000 ms hold, a deadline response about 1,850 ms after a send at +150 ms satisfies that inequality. A harness delay that dispatches Bob's request after Alice's commit also returns the stored seq-1 message and passes.
  Why it matters / what to change: The required two-MCP wake-up can pass as an ordinary read-after-send. Prove the request entered the hold before sending, or use an oracle tied to the remaining deadline that makes the deadline-only and delayed-dispatch cases fail.

- [medium] The Unicode fixtures do not detect NFC normalization of message text.
  Evidence: the contract requires exact raw payload preservation at `docs/implementation/spec-1-8-first-conversation-integration-checkpoint.md:45,47,77`. The test fixtures at `tests/integration/first-conversation.test.mjs:59-60` use precomposed accents (`é`, U+00E9; `ï`, U+00EF), which are already NFC; the exact text assertions at `:587` and `:615` therefore still pass if production normalizes to NFC.
  Why it matters / what to change: This oracle misses a transformation of decomposed input. Include a decomposed sequence such as `e\u0301` and assert its code-point sequence survives both the same-Actor path and the foreign envelope.

# Checks
- `node --version` → exit 0, `v24.18.1`. `node --test tests/integration/first-conversation.test.mjs` → sandbox attempt exit 1 (`EPERM` at `mkdtemp`, test line 274); permitted rerun exit 0: `ℹ tests 1`, `ℹ pass 1`, `ℹ fail 0`.
- `node --test` → exit 0: `ℹ tests 299`, `ℹ pass 299`, `ℹ fail 0`, `ℹ skipped 0`.
- `grep -nE 'sinon|proxyquire|mock|createServer\(' tests/integration/first-conversation.test.mjs` → exit 1, no matches (expected). `grep -nE 'createMcpServer|startServer\(' tests/integration/first-conversation.test.mjs` → exit 1, no matches (expected). `rg -n '[[:blank:]]+$' docs/implementation/spec-1-8-first-conversation-integration-checkpoint.md docs/implementation/workflows/agent-room-story-build.ts tests/integration/first-conversation.test.mjs docs/implementation/reviews/story-1-8-luna-brief.md` → exit 1, no trailing-whitespace matches.
- `git rev-parse HEAD` → exit 0, `17def1c7c5caaeef1c5bd5f3da53dbec750d55a8`. `git diff --name-status 17def1c7c5caaeef1c5bd5f3da53dbec750d55a8 --` → exit 0, empty. `git ls-files --others --exclude-standard` → exit 0, four untracked files: the three supplied paths plus `docs/implementation/reviews/story-1-8-luna-brief.md`; the supplied change list omitted that brief.
- `git diff --check` → exit 0, empty; it does not check the four untracked files. `shasum -a 256` recheck → exit 0; hashes matched the initial pin: spec `7cd1237be619bdc167ab1df7b1599ab9f74838c101ce40bc49a852eac45aa513`, workflow `8beeace5febb62623526ccc7568b7bd29ca28902655175a043a5a255eb7fcb0d`, test `2290c64ba0c5bd50c9ec449cc3a3dab5b02dced1afd5177f25f2f2b19b3f9cb4`, brief `d4a69cf18e44e1856a8bf05d8138f571ec90d3e0657bbc2ffc1ade313cc3d47e`.
- Not run: the `zcode-workflow` file has no runner in this package (`package.json` exposes only `test` and `package` scripts); executing it would run implementation, patch, and commit phases. No workflow-runtime behavior is claimed.

TEAM_DONE story-1-8-audit-luna
