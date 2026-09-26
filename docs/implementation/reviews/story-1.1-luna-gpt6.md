# Story 1.1 Audit — codex-advisor[luna] (gpt-6-luna[max])

Scope: final HEAD 961e6f59e7c4a908783b3bca9c112490922cd06a. Tracked files were clean before this output write. Reviewed source hashes were rechecked and unchanged. Tests were inspected, not executed; spec line 154 records an earlier test run and does not verify this HEAD.

# Verdict
FIX-FIRST

# Findings
- [medium] The static constants and dependency guards miss violations that are present in the source.
  Evidence: tests/constants.test.mjs:79-90 limits scanning to a short spelling list, and :396-419 applies only that pattern. Current misses include server/runtime.mjs:131's 64 * 1024 default, server/roomd.mjs:379's 15_000 keepalive against constants.mjs:52's 30-second value, and server/cli/agent-room.mjs:51's CONFLICT_STATUS 409 against constants.mjs:189's chat_id_taken status. tests/zero-deps.test.mjs:36-40,52-73 recognizes literal import forms only, so a computed import specifier is invisible. The Story 1.1 triage log already records the SSE mismatch as deferred (spec:22-27) and rejects broad scanner expansion (spec:150); this finding is limited to concrete gaps in the existing guard.
  Why: the acceptance clause says every bound and error status comes from constants.mjs and that the static check catches restatements. These current values are outside the guard's patterns, so a clean scan would not establish that clause. A computed dynamic dependency can also evade the zero-dependency check.

- [medium] Key-file symlink-race protection silently drops on platforms without O_NOFOLLOW.
  Evidence: server/keys.mjs:64-80 validates by lstat, then opens with O_NOFOLLOW ?? 0 and checks the opened descriptor. tests/keys.test.mjs:113-128 skips the symlink test on Windows. The Node v24 filesystem documentation says Windows does not expose O_NOFOLLOW: https://nodejs.org/download/release/v24.20.0/docs/api/fs.html. FR-1 marks Windows conditional on smoke testing (prd.md:81).
  Why: with the flag absent, a symlink inserted between lstat and open is followed; fstat sees the regular target, which can then be read and chmodded as the identity file. Static symlinks are refused, but the race case is not protected on that platform.

- [low] Runtime tests do not exercise the direct-launch gate diagnostic branch.
  Evidence: tests/runtime.test.mjs:104-120 starts node -e, dynamically imports each entrypoint, then its own rejection handler writes the diagnostic. server/cli/agent-room.mjs:277-285 takes a different path when launchedDirectly() is true.
  Why: the current direct-launch code is correct by inspection, but these tests can pass if that branch later stops printing the gate and found version or exits incorrectly.

- [low] PRD FR-3 describes possession proof for every connection, while the ratified local path does not prove possession.
  Evidence: prd.md:99-102 has no Local Mode carve-out. ARCHITECTURE-SPINE.md:73 describes the local-token issuance path, and :108 explicitly says local public-key presentation is not possession proof. server/api/server.mjs:191-199 computes the Actor fingerprint from that presented key after checking the local token.
  Why: the raw-key fingerprint implementation is correct, but the fingerprint alone does not prove private-key possession in Local Mode. The dated AD-5/AD-8 local decision controls; keep its OS-user boundary and retain challenge proof for the remote path.

- [low] AGENTS.md still gives the stale Node floor documented by this story.
  Evidence: AGENTS.md:6 says Node >=24 and :40 says Node <24 fails; runtime.mjs:22 requires 24.15. The spec already records this managed-block deferral at :15-20.
  Why: operators may treat Node 24.0-24.14 as supported. This is the previously recorded low-severity documentation deferral.

# Checks
1 — FINDING F1/F2/F3. Keypair fresh/reload/invalid, manifest dependency, source node_modules, and packaged-artifact rows have named tests. The current static guards have the gaps above. The direct-launch error branch is source-inspected only.
2 — PASS. keys.mjs:49-59 extracts the final 32 SPKI bytes; :41-47 hashes exactly 32 bytes with lowercase hex and the sha256: prefix. tests/keys.test.mjs:45-56 checks raw-byte hashing and rejects the SPKI-DER digest. Later consumers retain the same value: api-client.mjs:245,272,439 uses the keypair fingerprint for authentication and envelope comparison; room-log.mjs:111-115,229-231 validates and sorts those fingerprints for DM pair keys.
3 — FINDING F2. Mode, regular-file, size, invalid-material, no-regeneration, atomic publish, and concurrent-creator behavior are covered by keys.mjs:61-160 and tests/keys.test.mjs:25-188. Corrupt or truncated material fails as identity_key_invalid, and an early read end fails closed. O_NOFOLLOW protects the lstat/open race where available; the Windows test is skipped and the flag fallback leaves that race open.
4 — FINDING F3. runtime.mjs:53-69 enforces Node 24.15 and SQLite 3.51.3. mcp-stdio.mjs:61-68, roomd.mjs:40-48, api/server.mjs:1008-1016, and the setup CLI gate at server/cli/agent-room.mjs:277-285 all call it. tests/runtime.test.mjs:25-30 includes all four entrypoints and :124-149 checks below-floor, exact-floor, and error text through the import seam. No entrypoint override bypass was found; the direct-launch branch itself is not exercised.
5 — FINDING F1. PUBLIC_ERROR_STATUS is table-tested at tests/constants.test.mjs:247-354 and consumed by the API pipeline, but the static guard misses active bounds/status restatements listed in F1.
6 — FINDING F4/F5. AD-1's single HTTP(S) wire path and D13's Actor-versus-Session model align with the implementation. The local proof wording mismatch and managed AGENTS.md floor remain as recorded above.

TEAM_DONE story-1-1-audit-luna
