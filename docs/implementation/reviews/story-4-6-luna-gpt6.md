# Story 4-6 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
FIX-FIRST

Scope: HEAD is b9327bb33058579f1f9bdf8e12175017849e1452. The tracked diff is 13 files, +694/-45. The only untracked path observed was docs/implementation/reviews/story-4-6-luna-brief.md; it was not opened. No other review file or outbox was read. The 16 reviewed changed/contract/planning files had identical SHA-256 hashes at the start and end of this audit.

# Findings
- [medium] agent-room capacity omits the database and WAL byte counts required by FR-22.
  Evidence: docs/prds/prd-agent-room-2026-09-20/prd.md:290; server/cli/capacity-commands.mjs:82-93; tests/storage-gates.test.mjs:1002-1017.
  Why: the JSON exposes data_dir, free_bytes, the two reserves, state, admits_appends, and detail, but no database or WAL sizes. The operator cannot see the file usage FR-22 names. The spec matrix row 13 and its test also omit those fields.

- [medium] the storage_low result omits room_id, contrary to the binding wire shape.
  Evidence: docs/implementation/spec-4-6-storage-admission-control.md:22,43; server/api/server.mjs:843-844; server/api/server.mjs:848-853; tests/storage-gates.test.mjs:480-485,659-665.
  Why: the route returns exactly {status:'storage_low'} while the contract requires {status:'storage_low', room_id}; duplicate_dropped already demonstrates room_id as an existing result field. The new tests assert the smaller shape, so they pin the mismatch. In addition, the disk-full wire/reopen test uses in-process startTestServer (tests/storage-gates.test.mjs:178-188,453-510); the separate direct-child test proves an env-tuned refusal but does not stop and reopen (911-933). The AC evidence calls the disk-full wire route “spawned” at docs/implementation/ac-evidence.yaml:1180-1182, which overstates that process boundary.

- [low] the clock is not injectable at the server layer as the intent contract promises.
  Evidence: server/api/server.mjs:999-1003; server/api/server.mjs:834-841; server/store/room-log.mjs:1339-1348; server/store/storage-gate.mjs:175-189; tests/storage-gates.test.mjs:344-358,740-760.
  Why: the store accepts appendMessage nowMs and the gate uses it, but startServer has no storage clock option and the HTTP route does not pass one. The server-level warn test exercises immediate calls on the default wall clock, so it does not prove the append clock can be injected through the server.

- [low] matrix rows 12 and 14 are not pinned by all their stated assertions.
  Evidence: tests/storage-gates.test.mjs:970-998; tests/storage-gates.test.mjs:1110-1127; docs/implementation/spec-4-6-storage-admission-control.md:47,49.
  Why: row 12's test compares two statfs observations but does not compare with df or write a file to assert free space shrinks. Row 14's guide test checks the WARN knob and a generic storage_low/failure-mode mention, but not the REFUSE knob or the SQLITE_FULL failure row. The guide currently contains those items at docs/self-hosting-storage.md:31-32,187, but this pin would pass if either were removed.

- [low] internal-2-6 is only partially closed; the corrected index-test citation does not prove the retained flat-cost claim.
  Evidence: server/store/room-log.mjs:849-851; tests/rate-gates.test.mjs:322-338,340-364.
  Why: the cited rows exist and correctly pin an EXPLAIN plan and convergence, but the plan SQL is hand-copied and there is no 30k-row or flat-append-cost assertion. The comment still says flat cost across a 30k-row log is proven.

- [low] a conditional skip remains in a touched test file, despite the unqualified no-skip rule.
  Evidence: tests/ensure-server.test.mjs:351.
  Why: the unreadable-startup-lock test skips on Windows. This is outside the delta hunk and was not introduced by this hardening pass; the run on this host skipped zero tests.

# Checks

1. FINDING F1-F4; other intent clauses PASS.

Intent and Always:
- PASS — statfsSync(dataPath).bavail * bsize is the actual source at server/store/storage-gate.mjs:50-53. The defaults and interval are declared in server/constants.mjs:102-104; threshold parsing/resolution is shared in server/store/storage-gate.mjs:70-85,88-116 and used by openRoomLog, startServer, and capacity.
- PASS — appendMessage runs under withImmediateTransaction at server/store/room-log.mjs:1350-1352. The idempotency lookup returns before the duplicate probe at 1356-1369; duplicate drops return before storageGate.check at 1401-1420; the check immediately precedes insert at 1420-1427. There is one storageGate.check call in the store.
- PASS — withImmediateTransaction rolls back before rethrowing at server/store/room-log.mjs:355-378; the append catch maps only errcode SQLITE_FULL to coded storage_low at 1459-1468. The store-level bounded ceiling proof is tests/storage-gates.test.mjs:389-451.
- FINDING F2 — the send route answers storage_low as a 200 result, not an error envelope, but returns no room_id (server/api/server.mjs:822-845). Committed and duplicate_dropped results include room_id at 848-855. The storage_low assertions currently require status only.
- FINDING F1 — capacity opens no store and shares the gate's statfs/resolution path (server/cli/capacity-commands.mjs:7-18,29,45-69), but does not expose database/WAL bytes required by FR-22. Corrupt-store and absent-store behavior is exercised at tests/storage-gates.test.mjs:1002-1017,1080-1106.
- PASS with FINDING F3 — the gate owns per-store-connection rate state and uses the append's nowMs at server/store/storage-gate.mjs:160-189; the store captures the warning and calls the sink only after the transaction returns at server/store/room-log.mjs:1128-1144,1453-1458. Rollback drops the captured line. The between-reserves append commits in tests/storage-gates.test.mjs:575-599 and the server sink is tested at 740-784. The server itself has no injectable clock, as F3 records.
- PASS — thresholds reject malformed values at open/startup and require refuse <= warn; tests cover grammar, open, startup, and env fallback at tests/storage-gates.test.mjs:270-294,601-643,786-835,911-966. Per-key fallback then pair validation is stated in server/store/storage-gate.mjs:88-98 and docs/self-hosting-storage.md:43-52. A direct pure-function check of WARN=0 plus junk REFUSE returned {"code":"invalid_argument","storageWarnFreeBytes":0,"storageRefuseFreeBytes":268435456,"warningCount":1}; the fallback occurs and the resolved contradiction still fails coded.
- PASS — the guide contains backup, restore, expansion, and failure procedures at docs/self-hosting-storage.md:100-188; the warn row says every message append at line 25; storage sizing, auto-start inheritance, and upgrade-time schema recovery are at 35-65,180,194. No TLS claim was found by rg -n -i TLS docs/self-hosting-storage.md.

Block If, clause by clause:
1. PASS — refusal and disk-full sends are not acknowledged: tests/storage-gates.test.mjs:453-510,647-691; wire shape mismatch is F2.
2. PASS — refused work leaves the committed prefix/head intact and recovery is gap-free: tests/storage-gates.test.mjs:422-450,532-540,487-509.
3. PASS — reads, room enumeration, and presence continue during refusal: tests/storage-gates.test.mjs:713-738.
4. PASS — retries and duplicate drops resolve before the storage gate: server/store/room-log.mjs:1356-1369,1401-1420; tests/storage-gates.test.mjs:543-573.
5. PASS — the gate is inside the append transaction immediately before insertion: server/store/room-log.mjs:1352,1413-1427.
6. PASS for executable thresholds — actual byte values are defined in server/constants.mjs:102-104 and imported by the gate/store/server. Human-readable defaults also appear in guide/help prose.
7. PASS — storage admission adds no delete/prune behavior; the gate is explicitly a reserve and the log remains append-only: server/store/storage-gate.mjs:5-11.
8. PASS — capacity calls statfs and the shared resolver without opening a store: server/cli/capacity-commands.mjs:7-18,45-69; corrupt-store proof at tests/storage-gates.test.mjs:1080-1092.
9. PASS — warning state is per gate and interval-limited; injected-clock boundary assertions are at tests/storage-gates.test.mjs:344-358.
10. PASS with resolved-pair qualification — junk values warn and fall back per key; an independently contradictory resolved pair remains invalid as specified by the deferred finding and guide: server/store/storage-gate.mjs:88-98; docs/self-hosting-storage.md:43-52.
11. PASS — malformed startServer overrides fail invalid_argument: tests/storage-gates.test.mjs:820-835.

Never:
- PASS — only appendMessage calls storageGate.check (server/store/room-log.mjs:1420); read/presence/room paths remain usable in tests/storage-gates.test.mjs:713-738. No delete verb or new status/error code was added; SEND_STATUSES remains the frozen six values at server/constants.mjs:186-193. F2 is a missing required field, not a newly registered field.
- PASS — one fresh statfs observation is made at the new-append gate; there is no timer gate or per-append warning. The same resolveStorageThresholds/capacityOf is used by the CLI and gate. Tests derive defaults from imported constants at tests/storage-gates.test.mjs:45-73.
- FINDING F6 — the touched ensure-server test file has the conditional Windows skip at line 351. The 95-test run on this host reported skipped=0.
- PASS — no TLS guidance appears in the storage guide.

I/O & Edge-Case Matrix:
| Row | Result and evidence |
|---|---|
| 1 | PASS — shared grammar and coded junk/order rejection: tests/storage-gates.test.mjs:270-294; open/startup consumers at 601-619,786-835. |
| 2 | PASS — exact ok/warn/refuse and admitsAppends boundary: tests/storage-gates.test.mjs:296-302. |
| 3 | PASS — below/between/above, coded refusal, warning fields, and snapshot: tests/storage-gates.test.mjs:304-342. |
| 4 | PASS — injected-clock interval boundary plus committed store warning: tests/storage-gates.test.mjs:344-358,575-599. |
| 5 | PASS — new append refuses with no row/head movement and next sequence is gap-free: tests/storage-gates.test.mjs:512-541. The oracle checks durable rows/head, not a byte digest; source orders refusal before any insert. |
| 6 | PASS — exact retry, duplicate drop, read page, and head resolve below reserve: tests/storage-gates.test.mjs:543-573. |
| 7 | PASS — bounded maxPageCount loop, coded disk-naming refusal, silent gate warn sink, rollback prefix, retry, further refusal, recovery, and wire mapping: tests/storage-gates.test.mjs:389-451,453-510. |
| 8 | FINDING F2 — 200/not-acknowledged and stop/reopen proof exist at tests/storage-gates.test.mjs:647-691, but the required room_id is absent; the stop/reopen test is in-process, while the direct-child refusal test at 911-933 does not restart. |
| 9 | PASS — message reads, room enumeration, and presence answer during refusal: tests/storage-gates.test.mjs:713-738. |
| 10 | PASS with FINDING F3 — injected and default sinks are exercised at tests/storage-gates.test.mjs:740-784; post-commit emission is structurally after transaction return at server/store/room-log.mjs:1453-1458. Server clock injection is not present. |
| 11 | PASS — startup overrides, malformed values, direct child raised reserve, and junk fallback/defaults: tests/storage-gates.test.mjs:786-966. |
| 12 | FINDING F4 — live statfs value is finite and agrees within 2% with a second bavail*bsize observation at tests/storage-gates.test.mjs:970-998; no df comparison or file-write decrease assertion exists. |
| 13 | FINDING F1 — ok/warn/refuse JSON, exits, junk env, absent/corrupt store, and non-ENOENT statfs failure are covered at tests/storage-gates.test.mjs:1002-1106; FR-22 database/WAL bytes are absent from implementation and matrix. |
| 14 | FINDING F4 — the required guide sections exist and are regex-pinned at tests/storage-gates.test.mjs:1110-1127, but the test only pins WARN env and generic failure/storage_low wording, not REFUSE env or the SQLITE_FULL recovery row. |

2. FINDING F5; deferred findings:
| Finding | Result and evidence |
|---|---|
| internal-2-1 | PASS — real appendMessage ceiling loop with free space at 2 GiB; mapped AgentRoomRuntimeError storage_low names disk-full, warn sink is empty, committed prefix/head and retry are checked, then a fresh connection takes the gap-free next seq: tests/storage-gates.test.mjs:389-451. Wire result and durable absence after stop/reopen: 453-510. The intermediate SQLite error is mapped, so the test asserts the coded outcome/message rather than exposing the raw errcode object; the configured page ceiling is asserted at room-log.mjs:331-335 and the catch checks SQLITE_FULL at 1465-1468.
| internal-4-2 | PASS — withImmediateTransaction rolls back before appendMessage maps/rethrows at server/store/room-log.mjs:355-378,1459-1468; exercised by the row-7 tests above. |
| internal-2-2 | PASS — actual direct-launch child uses server/api/server.mjs with env knobs; raised refuse rejects over HTTP and junk produces one warning with defaults proven by a commit: tests/storage-gates.test.mjs:838-966; parsing is wired at server/api/server.mjs:1485-1499. |
| internal-4-3 | PASS — spawn whitelist retains PATH/LANG/data dir and forwards only the two storage names when set as opaque strings: server/client/ensure-server.mjs:527-549. Real plugin auto-start refusal is asserted at tests/ensure-server.test.mjs:195-252; guide documents inheritance at docs/self-hosting-storage.md:35-39,194. |
| internal-1-1 | PASS — comment and guide state per-key fallback followed by resolved-pair validation: server/store/storage-gate.mjs:88-98; docs/self-hosting-storage.md:43-52. The WARN=0/junk REFUSE direct check returned invalid_argument after fallback, as recorded above. |
| internal-1-2 | PASS — “reserved for” wording is now accurate: server/constants.mjs:362-368. |
| internal-1-4 | PASS — gate callback captures the line and actual sink is invoked only after COMMIT returns; rollback leaves no sink call: server/store/room-log.mjs:1128-1144,1453-1458. The matrix's normal between-reserves append commits and warns at tests/storage-gates.test.mjs:575-599. |
| internal-1-5 | PASS — index body-copy cost is recorded in server/store/room-log.mjs:853-857 and docs/self-hosting-storage.md:61-65. |
| internal-1-6 | PASS — open path verifies ordered columns with pragma_index_info and emits database_schema_invalid on divergence: server/store/room-log.mjs:887-910; squatter plus recovery fixture at tests/rate-gates.test.mjs:370-409. |
| internal-2-7 | PASS — a same-name index over a different column set is refused; the corrected comment claim matches that tested case: server/store/room-log.mjs:861-867; tests/rate-gates.test.mjs:370-409. |
| internal-4-4 | PASS — same open-path verification and squatter/convergence proof as internal-1-6: server/store/room-log.mjs:887-910; tests/rate-gates.test.mjs:370-409. |
| internal-1-7 | PASS — upgrade-time open/schema-write failure and recovery row added at docs/self-hosting-storage.md:180. |
| internal-2-3 | PASS — corrupt store still yields one JSON line and exit 0; non-ENOENT statfs failure yields data_directory_invalid and exit 1: tests/storage-gates.test.mjs:1080-1106. Absent store is covered at 1002-1017. |
| internal-2-4 | PASS — MCP RESULT carries storage_low, empty log/head, and clean stderr: tests/mcp-tools.test.mjs:593-627. |
| internal-4-6 | PASS — same MCP tool RESULT/empty-log proof as internal-2-4: tests/mcp-tools.test.mjs:593-627. |
| internal-2-5 | PASS — source comment records the 2% bavail/bfree limitation and test rationale: server/store/storage-gate.mjs:21-24; tests/storage-gates.test.mjs:980-990. |
| internal-2-6 | FINDING F5 — citation now points to real tests/rate-gates.test.mjs rows, but those rows pin a hand-copied plan and convergence, not the retained flat 30k-row append-cost claim: server/store/room-log.mjs:849-851; tests/rate-gates.test.mjs:322-338,340-364. |
| internal-4-5 | PASS — guide says every message append at docs/self-hosting-storage.md:25; the only storage gate call is the append path at server/store/room-log.mjs:1420. |

3. FINDING F1,F2,F4-F6; other regression/record checks PASS.
- The maxPageCount seam is positive-safe-integer validated at open and start, applied last and asserted on the connection at server/store/room-log.mjs:322-335,959-967; server/api/server.mjs:1124-1129. Direct launch and CLI do not read it as an operator knob.
- The SQLite-full loop is bounded to 64 attempts and asserts disk-naming storage_low, empty warning sink, committed prefix/head, exact retry, another refused new send, and fresh-connection gap-free recovery at tests/storage-gates.test.mjs:389-451. Removing the mapping causes the coded-class/message assertions to fail.
- All eight added ac-evidence pointers resolve to exact test names: tests/storage-gates.test.mjs:389,453,911,935,1080; tests/mcp-tools.test.mjs:593; tests/ensure-server.test.mjs:195; tests/rate-gates.test.mjs:370. CHANGELOG.md:222-230 accurately describes the tested page-ceiling mapping, plugin env forwarding, deferred warning, and column-set verification.
- The workflow JSON change is bookkeeping only: docs/implementation/workflows/.unattended-proven.json:1 now records story 4-5 at the audit baseline and does not contradict Story 4.6.
- No new .only/.skip/todo was added by the delta. The pre-existing conditional skip at tests/ensure-server.test.mjs:351 is F6. The outbox brief is the only unrelated untracked file observed.
- Exact targeted command: node --test --test-timeout=300000 tests/storage-gates.test.mjs tests/rate-gates.test.mjs tests/ensure-server.test.mjs tests/mcp-tools.test.mjs
  Result on elevated rerun: 95 tests, 95 pass, 0 fail, 0 skipped, 0 todo (20.1 s). The initial read-only attempt had 22 pure-test passes and 73 fixture-backed setup failures at mkdtemp under /var/folders/.../T (EPERM); those fixture assertions did not run. This was a sandbox write restriction, not a product failure. The full suite was not run.

TEAM_DONE story-4-6-audit-luna
