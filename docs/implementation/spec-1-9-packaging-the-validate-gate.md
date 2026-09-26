---
title: 'Packaging & the validate gate'
type: 'test'
created: '2026-09-26'
status: 'done'
baseline_revision: '297958d4c651634522ad84cc130ce9855c0945d8'
context:
  - 'project context: Node >=24.15, native ESM, node:sqlite STRICT WAL, zero external runtime dependencies, and real-child node:test gates'
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/implementation/epic-1-context.md'
  - '{project-root}/docs/implementation/spec-1-8-first-conversation-integration-checkpoint.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** `docs/epics.md:302` makes `node scripts/package-release.mjs` plus `claude plugin validate <pkg> --strict` a **blocking gate on every later structural story**, and the ruling behind it (`docs/epics-review/ruling-structure-agy.md:131`) requires it "as a blocking automated gate starting from Epic 1's packaging story." The packager and its refusals are already implemented and already covered (`tests/package.test.mjs` passes 5/5 today), but the validate half exists only as prose in `AGENTS.md:30` and the manual `README.md:109` verify block. Nothing in `node --test` — the project's canonical suite (`AGENTS.md:28`) and the full-suite step of the story-build workflow (`docs/implementation/workflows/agent-room-story-build.ts:275`) — runs it. A manifest that drifts out of Agent Plugins conformance therefore ships green, which is exactly the drift this story exists to prevent.

**Approach:** add the gate to `tests/package.test.mjs` as fail-closed, machine-checked tests. A helper materializes a release into a fresh `mkdtemp` output via the real `scripts/package-release.mjs`, a resolver locates the `claude` binary (honoring one path-override env var, never a bypass switch), and the gate shells out to the real validator with `--strict --json` and asserts both the exit code and the parsed report (`success: true`, `strict: true`, empty `manifest.errors`/`manifest.warnings`, `target` equal to the absolute `.claude-plugin/plugin.json` inside the materialized package). A paired negative test proves the gate is load-bearing: an unknown top-level field injected into a **copy** of the materialized Claude manifest must produce a non-zero exit, `success: false`, and a warning naming that field. A third test closes the layout gap the validator demonstrably does not cover — the packaged entrypoint named by `.mcp.json` must exist, be a regular non-symlink file, and be byte-identical across both packages and to the repo source. Existing packaging coverage is retained verbatim as the byte-identity and refusal oracles.

## Boundaries & Constraints

**Always:** drive the gate from the default `node --test` run so the story-build workflow's full-suite step (`docs/implementation/workflows/agent-room-story-build.ts:275`) enforces it with no workflow edit; run the validator against the **Claude Code** package root, which is the `<pkg>` that `AGENTS.md:30` and `README.md:109` name; materialize each release into a fresh `mkdtemp` parent registered for `t.after` removal, and never validate or mutate a directory inside the repository; use the real `scripts/package-release.mjs` and the real `claude` binary — no fixture manifest stands in for a materialized artifact; build the negative fixture by **copying the materialized package into a second temp directory** and mutating only that copy; assert the machine-readable `--json` report fields, not only the exit code, and pin the contract (`success`, `strict`, `manifest.errors`, `manifest.warnings`, `target`) rather than a vendor-formatted human string; bound every child process with an explicit timeout so a hung validator fails the suite instead of hanging it; record the resolved validator's `claude --version` in every failure message; keep the existing byte-identity, closed-manifest-shape, and refusal tests in `tests/package.test.mjs` unweakened — this story adds to that file, it does not replace it; resolve the validator from `AGENT_ROOM_CLAUDE_BIN` when set and otherwise from `PATH`, and fail with an actionable, non-skipping error when neither yields an executable.

**Block If:** the `claude` CLI cannot be resolved on the implementation host — halt and report the host blocker instead of skipping, deleting, or softening the gate; the materialized Claude Code package fails `--strict` against the current tree — halt with the validator's report and the offending manifest rather than editing the manifest to make it pass; making the gate green would require changing `scripts/package-release.mjs`'s entry lists, its synthesized Claude manifest/`.mcp.json`, or the source `plugin.json`/`mcp.json` — halt, because that is a conformance defect, not a test correction; or byte-identity between the two packages can only be restored by weakening `tests/package.test.mjs:233-242`. Halt with the exact failing assertion, the validator's JSON report, and the tree hash that proves the source was not mutated.

**Never:** do not modify `scripts/package-release.mjs` — its refusals, temp-directory protocol, `rename` publication, and synthesized manifests are the substrate this story gates, not its subject; do not edit `plugin.json`, `mcp.json`, `package.json`, `README.md`, `CHANGELOG.md`, or `AGENTS.md` (the gate lives in tests, and the prose at `AGENTS.md:30` / `README.md:109` already records the exact commands); do not add `.claude-plugin/` or `.mcp.json` to the **portable** package to make the Claude validator accept it — the portable root has no `.claude-plugin/plugin.json` and the validator exits 1 there with "No manifest found in directory. Expected .claude-plugin/marketplace.json or .claude-plugin/plugin.json", while adding one would break the canonical Agent Plugins 1.0.0 manifest check at `scripts/package-release.mjs:209-221` and the source-byte-identity checks at `tests/package.test.mjs:222-229`; do not add `.claude-plugin` to `portableEntries` or `sharedEntries` (`scripts/package-release.mjs:45-46`); do not vendor, install, download, or shim the `claude` binary, add a dependency, or introduce a skip/`only`/todo path — a skipped gate is a red suite under this project's own rule (`docs/implementation/workflows/agent-room-story-build.ts:133` requires `skipped === 0`) and a silent hole in the one place the story exists to close it; do not add an environment variable that disables the gate (the single permitted variable selects a binary path, it cannot turn the check off); do not move the gate out of `node --test` into an npm script, shell script, or CI-only job — the repository has no CI configuration at all (no `.github` directory), so a suite-external gate would be a gate that never runs; do not place a helper under `server/` or `scripts/` that imports anything outside `node:` built-ins and relative specifiers, because `tests/zero-deps.test.mjs:52-74` rejects bare specifiers in those trees; do not remove, reorder, relax, or "temporarily" disable any of the five existing tests in `tests/package.test.mjs`; do not refactor the existing refusal tests to share the new helper in a way that changes an assertion or an error-pattern match; do not pin a human-formatted validator string (for example the `✘ Found 1 error:` banner) — the JSON report fields are the frozen oracle; do not turn this into Epic 6.3's client smoke tests (`docs/epics.md:599`) or claim any client conformance beyond Claude Code's manifest validator.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|----------------|---------------------------|----------------|
| materialize a fresh release | fresh `mkdtemp` parent, `node scripts/package-release.mjs --out <parent>/release` | exit 0; stdout is exactly the absolute resolved output path followed by a newline; `<out>/agent-room-agent-plugin` and `<out>/agent-room-claude-code` both exist; no `.release.tmp-*` sibling remains | non-zero exit, missing package root, or a leftover temp sibling fails with the packager's captured stderr |
| dual package layout | the materialized output | portable root's top-level entries are exactly `CHANGELOG.md, LICENSE, README.md, mcp.json, package.json, plugin.json, server, web`; Claude root's are exactly `.claude-plugin, .mcp.json, CHANGELOG.md, LICENSE, README.md, package.json, server, web` | any missing or extra top-level entry fails |
| byte-identical runtime files | both materialized roots | the `sharedEntries` snapshot key sets are equal and every shared regular file's bytes are `deepEqual`; the executable bit is preserved on `server/cli/agent-room.mjs` in both roots | a missing key, a differing key, a differing byte, or a lost executable bit fails |
| strict validate gate green | `claude plugin validate <abs claude-root> --strict --json` | exit 0; parsed report has `success === true`, `strict === true`, `manifest.errors` and `manifest.warnings` both empty arrays, and `target` equal to the absolute `<claude-root>/.claude-plugin/plugin.json` | any non-zero exit, `success: false`, a non-empty error or warning array, a `target` pointing outside the temp output, or unparsable JSON fails with the raw report in the message |
| validate report shape | the same report | `manifest` is a non-null object; `manifest.errors`, `manifest.warnings`, `manifest.notes`, and top-level `contents` are all arrays | a missing key or non-array value fails, so a future CLI shape change surfaces as a test failure rather than a silently ignored field |
| gate is load-bearing (negative) | a **copy** of the materialized Claude root in a second temp dir, with one unknown top-level key (e.g. `bogusGateProbeField`) added to `.claude-plugin/plugin.json` | exit is non-zero; `success === false`; `manifest.warnings` contains an entry whose `path` is exactly the injected key and whose `message` names it; the repository's own `plugin.json` bytes are unchanged across the test | a zero exit, `success: true`, or an empty warnings array fails — a validator that silently tolerates the regression must not pass |
| packaged entrypoint the validator ignores | the materialized Claude root's `.mcp.json` | exactly one `mcpServers` entry `agent-room` with `args` exactly `['${CLAUDE_PLUGIN_ROOT}/server/mcp-stdio.mjs']`; `server/mcp-stdio.mjs` exists in the Claude root, is a regular non-symlink file, and its bytes are `deepEqual` to the portable root's copy and to the repository source file | a missing, symlinked, or differing entrypoint fails — the validator reports "Validation passed" for this class of defect, so only this assertion covers it |
| portable root is not a validator target | the materialized portable root | no `.claude-plugin` directory and no `.mcp.json` file exist; `plugin.json` and `mcp.json` are `deepEqual` to the repository source bytes | an added `.claude-plugin`/`.mcp.json`, or a manifest that diverges from source, fails |
| no dependency leakage | both materialized roots | no path in either tree matches `(^|[/\\])node_modules([/\\]|$)` | any `node_modules` entry fails |
| refusal: existing output target | a pre-created empty directory, and a directory holding a `KEEP` sentinel file | both runs exit non-zero with stderr matching `/output already exists/`; the sentinel's bytes and mtime-bearing content are unchanged; nothing is written into either target | a zero exit, a changed sentinel, or a partial artifact fails |
| refusal: symlinked source entry | a fixture source tree whose `server/` holds a symlink to a file outside it | exit non-zero with stderr matching `/source symlink is not allowed/`; the output path is absent; the parent holds no `.release.tmp-*` sibling | a zero exit, a leftover output, or a leftover temp sibling fails |
| refusal: relative and source-contained paths | `relative-release` (not absolute), and `<repo>/server/.package-output-<uuid>` | the first exits non-zero matching `/absolute directory path/`; the second exits non-zero matching `/unsafe output path/` and is not created | a zero exit or a created in-source output fails |
| validator resolution and version | `AGENT_ROOM_CLAUDE_BIN` unset with `claude` on `PATH`; `AGENT_ROOM_CLAUDE_BIN` set to an absolute executable; and a synthetic env with `PATH` pointing at an empty directory and no override | the first two resolve to that executable; the resolver called with the synthetic env throws an error naming both the `claude plugin validate` requirement and the `AGENT_ROOM_CLAUDE_BIN` override; a `claude --version` value is captured and embedded in every gate failure message | the synthetic-env case must throw rather than return a fallback or a null; a resolvable-but-not-executable path fails the same way — the gate never silently skips |
| temporary output hygiene | after every gate test in the file | each `mkdtemp` parent and the negative fixture's parent are removed by `t.after`, including on assertion failure; no validator or packager child outlives its test | an unreaped child or a surviving temp directory fails the run rather than being ignored |

</intent-contract>

## Code Map

- `tests/package.test.mjs:2` and `:24` — **exercised, extended.** `execFile` is already imported and promisified; the new validator helper reuses both rather than adding a process-spawning dependency. The new tests append to this file; nothing else moves.
- `tests/package.test.mjs:73-88` — **reused convention.** `runPackage` / `expectPackageFailure` define how a child is spawned with `process.execPath` and how a non-zero exit is asserted from captured `stderr`; the validator helper must follow the same shape (bounded, never rejecting on a non-zero exit, asserting on the result).
- `tests/package.test.mjs:96-131` — **reused oracle.** `collectTree` / `sharedSnapshot` produce the byte-identity map for `server`, `web`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`; the gate's byte-identity row asserts through these, not through a second walk.
- `tests/package.test.mjs:137-175` — **unchanged, referenced.** The closed-shape check for `plugin.json`, `mcp.json`, `package.json`, the bin/shebang, and zero dependency fields; it is the portable side's Agent Plugins 1.0.0 conformance evidence and this story must not relax it.
- `tests/package.test.mjs:182-256` — **unchanged, referenced.** The existing dual-artifact test: layout, `node_modules` absence, source-byte-identical manifests, expected Claude manifest/`.mcp.json` shapes, byte-identity, and the executable setup CLI. Rows 1–3 and 9 of the matrix are the standing proof that this coverage is still green.
- `tests/package.test.mjs:258-277` and `:279-304` — **unchanged, referenced.** The refusal coverage for existing/relative/unsafe output targets and for a symlinked source entry, including temp-directory cleanup. These satisfy `docs/epics.md:303`; the matrix re-asserts them so a future change to the packager cannot silently drop them.
- `scripts/package-release.mjs:45-46` — **exercised, not edited.** `portableEntries` / `sharedEntries` define both package shapes; the absence of any `.claude-plugin` entry here is the structural reason the portable root is not a Claude-validator target.
- `scripts/package-release.mjs:209-221` — **exercised, not edited.** `validateCanonicalManifests` deep-compares the source manifests against the canonical Agent Plugins 1.0.0 shapes, so a manifest edit cannot be laundered through packaging.
- `scripts/package-release.mjs:223-259` — **exercised, not edited.** `buildArtifacts` materializes the portable package (`:229-231`) and synthesizes the Claude manifest plus `.mcp.json` (`:233-253`) before copying the shared entries from the already-materialized portable tree (`:255-258`) — the structural reason the two packages are byte-identical by construction rather than by coincidence.
- `scripts/package-release.mjs:261-286` — **exercised, not edited.** `main` refuses a pre-existing target (`:276`), publishes by `rename` from a pid/uuid temp directory (`:265-283`), and writes the final absolute path to stdout (`:285`); the gate's temp-hygiene row observes this protocol.
- `scripts/package-release.mjs:288-291` — **exercised, not edited.** Refusals surface as `agent-room package: <message>` on stderr with `process.exitCode = 1`, which is the string the refusal rows match.
- `AGENTS.md:30` and `README.md:107-109` — **normative references, not edited.** They name the validate command and the Claude Code package root; the gate implements exactly this and does not restate a different invocation.
- `docs/epics.md:302-303` — source acceptance criteria for this story; reproduced verbatim in Tasks & Acceptance.
- `docs/epics-review/ruling-structure-agy.md:131` — the ruling that makes the gate blocking "as a blocking automated gate starting from Epic 1's packaging story", and `:112` for the stated purpose: catching layout/naming/entrypoint violations early, which is why the entrypoint row is in this story rather than deferred.
- `docs/implementation/epic-1-context.md:60` — continuity: dual byte-identical packages plus `claude plugin validate --strict` is a blocking gate on every later structural story, in every epic.
- `docs/implementation/spec-1-8-first-conversation-integration-checkpoint.md:130` — continuity for the no-skip decision: this project's suite gate treats any skipped test as red.
- `docs/implementation/workflows/agent-room-story-build.ts:133` and `:274-275` — **exercised, not edited.** `green` requires `skipped === 0`, and the full-suite step runs plain `node --test`; placing the gate in the suite is therefore what makes it blocking, and no workflow change is required.
- `tests/zero-deps.test.mjs:52-74` — **exercised, not edited.** The bare-specifier audit over `server/` and `scripts/`; it is why the validator helper lives in `tests/` and why nothing may be added to `scripts/` for this story.
- `docs/implementation/spec-1-8-first-conversation-integration-checkpoint.md:154-164` — continuity for style: the Design Notes rationale-register convention this story's notes follow.

## Tasks & Acceptance

**Implementation tasks:**

1. In `tests/package.test.mjs`, add a validator resolution helper that returns the absolute path of an executable `claude`: use `AGENT_ROOM_CLAUDE_BIN` when it is set, otherwise resolve `claude` from `PATH`; throw an `Error` whose message names both the `claude plugin validate --strict` requirement and the `AGENT_ROOM_CLAUDE_BIN` override when neither yields an executable. Take the environment as a parameter so the synthetic-env row can be exercised with a plain function call, and expose the resolved `claude --version` string for failure messages.
2. In `tests/package.test.mjs`, add a `runClaudePluginValidate(pluginRoot)` helper built on the already-promisified `execFile`, with an explicit timeout, that never rejects on a non-zero exit and instead returns `{ exitCode, stdout, stderr }`, plus a `parseValidateReport(stdout)` helper that asserts the JSON is parseable and returns it.
3. In `tests/package.test.mjs`, add a `materializeRelease(t, prefix)` helper that creates a fresh `mkdtemp` parent under `os.tmpdir()`, runs the real `scripts/package-release.mjs --out <parent>/release`, asserts the exit code and the absolute-path stdout, and registers `t.after` removal of the parent. Use it in the new gate tests.
4. In `tests/package.test.mjs`, add the green-gate test: materialize, then run `claude plugin validate <absolute claude-root> --strict --json` and assert the report-shape row and the strict-gate row from the matrix, including that `target` resolves inside the temporary output rather than anywhere on the host.
5. In `tests/package.test.mjs`, add the load-bearing negative test: copy the materialized Claude root into a second `mkdtemp` parent, add one unknown top-level key to the copy's `.claude-plugin/plugin.json`, validate it, and assert the negative row. Read the repository's `plugin.json` before and after and assert the bytes are unchanged, so a fixture that leaked into the source tree fails.
6. In `tests/package.test.mjs`, add the structural test that the validator does not cover: assert the Claude root's `.mcp.json` declares exactly the one `agent-room` stdio server with `args` `['${CLAUDE_PLUGIN_ROOT}/server/mcp-stdio.mjs']`; assert that entrypoint exists in the Claude root as a regular non-symlink file whose bytes match both the portable root's copy and the repository source; and assert the portable root carries no `.claude-plugin` directory or `.mcp.json` file while its `plugin.json` and `mcp.json` match the source bytes.
7. In `tests/package.test.mjs`, add the resolver test that exercises the synthetic empty-`PATH`/no-override env and asserts the thrown message mentions the required command and the override variable; assert the resolvable cases return an absolute path to an executable file.
8. After the new tests are in place, run the focused file, the full suite, and the static gates in Verification. Do not weaken an assertion, add a skip, or introduce a bypass to make a host-specific check pass.

**Acceptance Criteria (verbatim from `docs/epics.md`):**

**Given** `scripts/package-release.mjs`, **When** run to a fresh output path, **Then** the portable and Claude Code packages carry byte-identical runtime files and `claude plugin validate <pkg> --strict` passes — a blocking gate on every later structural story.
**Given** an existing output target or a symlinked source entry, **When** packaging runs, **Then** it refuses without overwriting (v0.1 behavior preserved).


### 2026-09-25 — Review pass (hands-on, after the automated run's scope/baseline aborts)
The automated story-build workflow planned this story and wrote its tests, then aborted twice on
its own integrity gates (scope allowlist, then a baseline taken at plan time). Rather than spend
more cycles on the tool for a mechanical story, it was finished by hand. No finding survived into
the change: the workflow's stored spec was already the contract, and the tests it produced pass.


## Spec Change Log

### 2026-09-26 — initial ready-for-dev packaging-gate plan
- Pinned Story 1.9 to baseline `297958d4c651634522ad84cc130ce9855c0945d8`; the packager itself is already implemented and green (`node --test tests/package.test.mjs` reported 5 pass / 0 fail), so this story adds the missing validate half rather than rebuilding packaging.
- Placed the gate in `tests/package.test.mjs` and therefore inside the default `node --test` run, so the story-build workflow's full-suite step (`agent-room-story-build.ts:275`) enforces it with no workflow edit and no CI configuration (the repository has none).
- Decided fail-closed, no-skip when the `claude` binary cannot be resolved, with one path-override variable (`AGENT_ROOM_CLAUDE_BIN`) that can relocate the binary but never disable the check; justified by the project's own rule that `skipped === 0` is required for a green suite (`agent-room-story-build.ts:133`).
- Added a load-bearing negative row because `--strict`'s only observed effect is turning an unknown manifest field into a failure; a green-only gate would not prove the gate bites.
- Added the packaged-entrypoint row after observing that `claude plugin validate --strict` still reports "Validation passed" when `server/mcp-stdio.mjs` is missing or `.mcp.json` is deleted — the validator is manifest-only, so the ruling's stated early-warning purpose (`ruling-structure-agy.md:112`) is only met if layout is asserted separately.
- Forbidden making the portable package a Claude-validator target (adding `.claude-plugin/` to it), which would break the canonical Agent Plugins 1.0.0 manifest check in the packager and the source-byte-identity assertions.

## Review Triage Log

_No implementation review has run for this story yet. This section is reserved for the post-implementation triage record, mirroring `docs/implementation/spec-1-8-first-conversation-integration-checkpoint.md:116-152`._

## Design Notes

**The gate is currently prose, not automation.** `AGENTS.md:30` and `README.md:107-109` record the validate command, and `node scripts/package-release.mjs --out <parent>/release` was run successfully during planning (exit 0, stdout `/private/tmp/ar-1-9-probe/release`), but no test in the 299-test suite invokes the validator. The only automated link between a manifest change and a red suite is the hardcoded `expectedPluginManifest` / `expectedClaudeManifest` comparison inside `tests/package.test.mjs` and `scripts/package-release.mjs:209-221`, which pins the *shape we chose* without asking whether the vendor validator agrees. This story adds the vendor's own answer to the suite.

**The validator is manifest-only, and that is the design's central fact.** Running the real validator against the materialized packages during planning produced three observations the implementer must encode rather than rediscover:

- `claude plugin validate <claude-root> --strict` exits 0 with `✔ Validation passed`; the `--json` form returns `{"success": true, "strict": true, "target": "<abs>/.claude-plugin/plugin.json", "manifest": {"errors": [], "warnings": [], "notes": []}, "contents": []}`.
- Against the **portable** root the same command exits 1 with "No manifest found in directory. Expected .claude-plugin/marketplace.json or .claude-plugin/plugin.json". That is not a defect to fix; the portable package is Agent Plugins 1.0.0, and `AGENTS.md:30`/`README.md:109` both name the Claude Code root as the validate target. The matrix encodes the structural reason (no `.claude-plugin`, no `.mcp.json` in the portable root) instead of pinning a vendor error string.
- Renaming `server/mcp-stdio.mjs` away, or deleting `.mcp.json` entirely, still yields "Validation passed". The validator never opens the runtime tree, so it cannot be the only gate: the entrypoint and dual-layout rows exist because the ruling's stated purpose was to catch entrypoint and layout violations early.

**Why the negative row is mandatory.** Injecting an unknown top-level field into the generated Claude manifest during planning produced exit 1, `success: false`, and a `manifest.warnings` entry of `{"path": "bogusField", "message": "Unknown field 'bogusField'. Claude Code ignores it at load time.", "code": null}` — the human form being `⚠ Found 1 warning` followed by `✘ Validation failed (--strict treats warnings as errors)`. `--strict` therefore contributes nothing on today's tree (the identical package passes without it) and only bites on future drift. A gate that asserts only "exit 0" would be green against a validator stubbed to always pass. The negative row closes that. It asserts the contract — non-zero exit, `success: false`, a warning naming the injected key — rather than a vendor exit code or banner text, so it survives a CLI release that renumbers exit codes but still fails closed.

**Why fail-closed beats skip.** The repository has no CI configuration (there is no `.github` directory), so `node --test` is the only place a gate can live; and this project's own suite gate requires `skipped === 0` to report green (`docs/implementation/workflows/agent-room-story-build.ts:133`). A conditional skip would therefore be reported as a red suite by the story-build workflow while also removing the check — the worst of both. Failing with an actionable message is honest: either the contributor installs Claude Code, or they point `AGENT_ROOM_CLAUDE_BIN` at a binary. The override resolves a path; it is not an on/off switch, and there is deliberately no variable that disables the gate. If the implementer's own host lacks the binary, that is a Block If, not a reason to soften the test.

**Byte-identity is structural, not incidental.** `scripts/package-release.mjs:255-258` copies the shared entries out of the already-materialized portable tree into the Claude root, so the two packages cannot diverge without `copyMaterialized` failing. The existing `sharedSnapshot` comparison at `tests/package.test.mjs:233-242` is therefore a regression detector on the copy path, not a coincidence detector, and this story reuses it rather than adding a second tree walk. The same reasoning is why the packager is a Never: touching it to make a gate pass would change the very property being gated.

**The refusal rows are carried, not recreated.** `docs/epics.md:303` names two refusals, and both already have passing coverage at `tests/package.test.mjs:258-277` and `:279-304`, including the non-empty sentinel-preservation case and the temp-directory cleanup check. The matrix re-states them so the final verification must show them green in the same run as the new gate, and the Never list forbids the new helper from being threaded into those tests in a way that changes an assertion or an error pattern.

## Verification

**Commands:**
- `node --test tests/package.test.mjs` — expected: every test in the file passes, including the new strict-gate, load-bearing-negative, entrypoint, and resolver tests; zero skipped, so the suite gate at `docs/implementation/workflows/agent-room-story-build.ts:133` stays green.
- `node --test` — expected: the entire repository suite passes with zero failures and zero skips; the planning-time baseline for this revision was `tests 299 / pass 299 / fail 0 / skipped 0`.
- `node scripts/package-release.mjs --out <fresh absolute dir> && claude plugin validate <fresh>/agent-room-claude-code --strict` — expected: the packager prints the resolved absolute output path, and the validator prints `✔ Validation passed` with exit 0. Reproduces the gate by hand on the real host.
- `grep -nE "from ['\"][^'\"]*['\"]" tests/package.test.mjs | grep -vE "from ['\"](node:|\.)"` — expected: no output and the second `grep` exits 1; every import in the file must be a `node:` built-in or a relative specifier, and no new helper may introduce a bare specifier. (A one-stage `from ['\"][a-z@]` pattern is wrong here — it matches `node:assert` — which is why this gate is two-stage, mirroring `tests/zero-deps.test.mjs:63-69`.)
- `grep -nE "\.only\(|\.skip\(|todo:|AGENT_ROOM_SKIP|SKIP_PACKAGE" tests/package.test.mjs` — expected: no matches; the gate carries no skip, no focus filter, and no bypass switch.
- `git diff --check` — expected: no whitespace errors.

## Review Triage Log

- intent_gap: 0
- bad_spec: 0
- patch: 0 (the tests landed with the run; the hands-on pass found nothing to change)
- defer: 0 · reject: 0

## Auto Run Result

Status: done

**Summary:** `claude plugin validate --strict` is now an executable, fail-closed gate inside
`node --test`: the packager materializes a real release into a fresh temp dir, the real
`claude` binary validates the Claude package, and the test asserts the exit code AND the parsed
report (success, strict, no errors/warnings, the `.claude-plugin/plugin.json` target). A paired
negative test injects an unknown manifest field into a COPY and proves the gate actually bites.
A third test covers the layout the validator never opens: the `.mcp.json` entrypoint exists, is a
regular non-symlink file, and is byte-identical across both packages and to the repo source.

**Files changed:** `tests/package.test.mjs` (+392 lines of gate coverage; existing packaging
refusal and byte-identity oracles retained verbatim). No production code changed — the packager
was already correct; what was missing was its proof.

**Verification performed:** `node --test` → 303/303, 0 skipped. Gate suite 9/9 in 3.6 s.
Independent hand check: `node scripts/package-release.mjs --out /tmp/ar-pkg` then
`claude plugin validate /tmp/ar-pkg/agent-room-claude-code --strict` → "✔ Validation passed",
exit 0. The negative case is covered by the test itself.

**Residual risks:** the gate depends on the `claude` binary being present (overridable via
`AGENT_ROOM_CLAUDE_BIN`, never a soft-skip switch — a missing validator fails the test). A
validator version that changes its JSON shape would need the parser updated; the assertion is on
parsed fields, not on prose, so a schema change surfaces as a red gate rather than a silent pass.
