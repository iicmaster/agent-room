# Review — Reality-Check Lens (Web Verification)

- **Target:** `ARCHITECTURE-SPINE.md` (agent-room-v0.2, 2026-09-20)
- **Reviewer role:** architecture-spine reviewer gate — technology claims vs. reality, researched 2026-09-20
- **Method:** primary sources only (nodejs.org docs, nodejs/node changelog + commit search, sqlite.org release history, GitHub release tags) plus direct execution probes on the local Node v24.18.1 (darwin arm64) that ships with this repo's own runtime floor. The general-purpose search backend was rate-limited during this review; its model-generated fallback summary ("node:sqlite is stable in Node 24") was **discarded as inaccurate** — the primary sources below say *Release candidate (Stability 1.2)*, not stable. Nothing in this review rests on a search-engine summary.

## Verdict summary

| # | Spine claim | Verdict | Action |
| --- | --- | --- | --- |
| 1 | Node ≥ 24 is the right LTS line for Sep 2026 (Stack) | **Confirmed** | none (advisory note on maintenance date) |
| 2 | Ed25519 sign/verify via `node:crypto` (AD-5, AD-11) | **Confirmed** | pin fingerprint input encoding (exact edit) |
| 3 | `node:sqlite`, floor ≥ 3.51.3 asserted at startup (Stack, AGENTS.md) | **Confirmed, under-specified** | floor ⇔ Node ≥ 24.15.0 on stock builds — exact edit |
| 4 | SSE over `node:https`, built-in (Stack, AD-8, FR-18) | **Confirmed** | pin 4 default-timeout facts + heartbeat rationale (optional edit) |
| 5a | Caddy as the documented reverse proxy (AD-11) | **Confirmed** (v2.11.x current, no v3) | none |
| 5b | MCP stdio as the only agent-facing surface (AD-1, AD-3) | **Confirmed**, unpinned revision | advisory: pin MCP spec revision |
| 5c | `randomBytes`, `timingSafeEqual`, SHA-256 (AD-11) | **Confirmed** (no breaking 24.x changes) | none |

**Bottom line: nothing in the spine is stale.** Two claims are *under-specified* in ways that will bite implementers (claims 3 and 2); exact edits below.

---

## Claim 1 — Node ≥ 24 as the current LTS line (Sep 2026)

**Verdict: Confirmed.**

Per the official release schedule (nodejs/release README, read 2026-09-20):

| Line | Status on 2026-09-20 | Dates |
| --- | --- | --- |
| 24.x "Krypton" | **Active LTS** | initial 2025-05-06 · Active LTS 2025-10-28 · Maintenance from **2026-10-20** · EOL 2028-04-30 |
| 26.x | Current | initial 2026-05-05 · Active LTS from 2026-10-28 · EOL 2029-04-30 |
| 22.x "Jod" | Maintenance LTS | EOL 2027-04-30 |

"≥ 24" targets the Active LTS line while staying forward-compatible with 26 (the runtime check in `server/runtime.mjs` is major-based, so 26 passes). Node 22 cannot work anyway (the SQLite floor, claim 3, excludes it).

**No breaking 24.x changes** to any surface the spine uses. Full sweep of `CHANGELOG_V24.md` (24.0.0 → 24.21.0, 2026-09-08) for `node:crypto` / `node:sqlite` / `node:http` found only additive or hardening changes (details per claim below). One notable non-event: no HTTP timeout-default changes anywhere in the 24.x line.

*Advisory (no edit required):* Node 24 enters Maintenance on 2026-10-20 — one month after this spine's date. That is normal LTS cadence (fixes continue to 2028-04), not staleness, but it means "Active LTS" is technically true for only a few more weeks; "the LTS line" is the durable phrasing.

Sources:
- https://github.com/nodejs/release (README release table, read 2026-09-20)
- https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V24.md (full, swept locally)

## Claim 2 — Ed25519 in `node:crypto` (AD-5, AD-11)

**Verdict: Confirmed. Both API surfaces exist, are stable, and were executed successfully on Node v24.18.1.**

Surface A — classic `node:crypto` (available since Node 12; what AD-5 most naturally means):

- `generateKeyPairSync('ed25519')` → KeyObjects
- `crypto.sign(null, data, privateKey)` / `crypto.verify(null, data, publicKey, sig)` — digest must be `null` for EdDSA
- `publicKey.export({ type: 'spki', format: 'der' })` → 44-byte SPKI; `createHash('sha256')` over it

Executed on 24.18.1: sign/verify true, tampered-data rejection true, 43-char base64url token from `randomBytes(32)`, `timingSafeEqual` OK.

Surface B — WebCrypto (`globalThis.crypto.subtle`), relevant because a plugin may prefer it for the challenge-response path:

- `subtle.generateKey({ name: 'Ed25519' }, …, ['sign','verify'])`
- Docs history: "v23.5.0, v22.13.0 — Algorithms Ed25519 and X25519 are now stable" — i.e., stable across the entire ≥24 window the spine can actually reach (see claim 3).
- Key formats: Ed25519 supports `'spki' | 'pkcs8' | 'jwk' | 'raw' | 'raw-public'` — `raw` import/export (RFC 8032 32-byte key) executed successfully on 24.18.1.
- Only Ed448/X448 remain under the experimental "Secure Curves" (Stability 1.1) umbrella — irrelevant here.

**24.x-line changes worth pinning (none breaking, all hardening/additive):**

- 24.19.0 (2026-08-03): "crypto: reject small-order EdDSA points during verify" (PR #64026) — `verify()` became stricter against malformed public keys; correct-by-spec, no action, but a reason the floor should not be *below* late 24.x for the identity path.
- 24.16.0 (2026-05-21): "crypto: add support for Ed25519 context parameter" (PR #62474, SEMVER-MINOR) — additive.
- 24.12.0: "crypto: fix argument validation in crypto.timingSafeEqual fast path" (PR #60538) — a validation fix to the exact primitive AD-11 leans on; another argument for a reasonably recent floor.

**Under-specification worth one pinned sentence (exact edit):** AD-5 says "the public key's SHA-256 fingerprint is the Actor's stable identifier" but never fixes *what bytes* are hashed. SPKI-DER (44 bytes, classic API's easy default) and the raw 32-byte key (WebCrypto's `raw` export) hash to **different fingerprints** for the same key — and AD-6's Direct-Room pair ids (`direct:<min(fprA,fprB)>`) inherit the choice, making it a frozen-contract issue once actors enroll.

Proposed edit — append to AD-5's Rule:

> Fingerprints are SHA-256 over the raw 32-byte (RFC 8032) public key, hex-encoded with the `sha256:` prefix — one canonical encoding pinned once: SPKI-DER and raw digests differ for the same key, and AD-6's direct-room pair ids inherit the choice. Only one crypto surface (classic `node:crypto` KeyObjects or WebCrypto) may produce the digest.

Sources:
- https://nodejs.org/docs/latest-v24.x/api/webcrypto.html (Ed25519 stability history, supported algorithms/formats)
- Local execution probes on Node v24.18.1 (both surfaces, 2026-09-20)
- https://github.com/nodejs/node/pull/64026 · /pull/62474 · /pull/60538

## Claim 3 — `node:sqlite` status and the ≥ 3.51.3 floor

**Verdict: Confirmed, under-specified. The floor is right and load-bearing — but on stock Node builds it silently means "Node ≥ 24.15.0," which the spine's Stack table does not say.**

### Status: no longer "experimental with warning" — Release candidate since 24.15.0

- v24 docs: module is **Stability: 1.2 — Release candidate**, per "sqlite: mark as release candidate" (PR #61262) in **Node 24.15.0 (2026-04-15)**.
- Unflagged since v23.4.0 / v22.13.0 (no `--experimental-sqlite`).
- **Warning noise:** importing `node:sqlite` and opening a database on 24.18.1 emits **no ExperimentalWarning** (verified by execution). On 24.0–24.14 (Stability-1.1 era) the import prints an ExperimentalWarning to stderr — but see below: those versions are already rejected by the version floor, so the plugin's *effective* support window (≥ 24.15) is exactly the warning-free window. No stderr noise for a shipped plugin.
- **Semver risk:** real but bounded. The 24.x line shows continued additive churn — authorization API (24.10), tagged templates (24.9), `defensive` flag (24.12), **defensive mode on by default** (24.14, PR #61266), `limits` property (24.15), `serialize()`/`deserialize()` (24.16) — plus a security release (CVE-2026-58041, fixed in 24.18.1). A store adapter using only the boring core (`open`/`exec`/`prepare`/`run`/`get`/`all`, transactions) is low-risk. The defensive-mode default does **not** affect v0.1-style usage (verified: `database.mjs` opens `new DatabaseSync(path)` option-less and sets `PRAGMA journal_mode = WAL`; plain DDL and WAL pragmas are unaffected — defensive mode blocks hostile schema tricks, which is a benefit).

### The floor: 3.51.3 exists and is the right number — with a rationale and a mapping the spine omits

- SQLite 3.51.3 was released **2026-03-13** and is the release that **fixed the "WAL-reset database corruption bug"** (sqlite.org change log). For a single-writer **WAL-mode** store (AD-2, NFR conventions), choosing 3.51.3 as the floor is substantively correct, not arbitrary.
- Node itself took 3.51.3 seriously: main briefly bundled 3.52.0 (2026-03-10) — a version SQLite **withdrew** — then moved to 3.51.3 (PR #62256, 2026-03-17).
- Mapping from the v24 changelog ("deps: update sqlite" per release):

| Node 24.x release | Bundled SQLite |
| --- | --- |
| 24.0 – 24.5 (May–Jul 2025) | 3.49.x → 3.50.3 |
| 24.6 – 24.12 (Aug 2025 – Dec 2025) | 3.50.4 |
| 24.13.x – 24.14.x (Jan–Feb 2026) | 3.51.0 – 3.51.2 (WAL-bug era) |
| **24.15.0 (2026-04-15)** | **3.51.3** — first ≥ floor |
| 24.16.0 → 24.20.0 | 3.53.0 → 3.53.1 → 3.53.3 → 3.53.4 |
| local 24.18.1 | 3.53.4 (`process.versions.sqlite` = `sqlite_version()`, verified) |

Consequence: **the Stack table's two rows are not independent.** On stock Node builds, "Node ≥ 24" plus "SQLite ≥ 3.51.3" means Node ≥ 24.15.0; a user on Node 24.0–24.14 passes the Node check and is rejected at startup with `sqlite_version_unsupported`. That is the assert working as designed (24.13.x–24.14.x ship the WAL-corruption era 3.51.0–3.51.2) — but the spine should say so, because "requires Node ≥ 24" in README/packaging would be misleading.

Proposed edit — Stack table, replace the SQLite row:

> `| SQLite via node:sqlite | ≥ 3.51.3 (asserted at startup). On stock Node builds this floor means Node ≥ 24.15.0 — Node 24.0–24.14 bundle SQLite 3.50.x–3.51.2 and fail the assert. 3.51.3 (2026-03-13) is the SQLite release that fixed the WAL-reset corruption bug; module status is Stability 1.2 (release candidate) from 24.15 — no ExperimentalWarning. |`

Sources:
- https://nodejs.org/docs/latest-v24.x/api/sqlite.html (Stability 1.2; flag history)
- https://sqlite.org/changes.html (3.51.3 date + WAL-reset corruption fix; 3.52.0 withdrawn; 3.53.4 newest)
- CHANGELOG_V24.md per-release "deps: update sqlite" entries; PRs #62256, #61262, #61266
- Local: `node -p process.versions.sqlite` on 24.18.1 → 3.53.4; silent import

## Claim 4 — SSE over `node:https` (plain responses)

**Verdict: Confirmed. Nothing Node-24-specific changes SSE behavior; the changelog shows only keep-alive fixes and additive options. Pin the four default-timeout facts so the SSE design isn't re-litigated at implementation.**

- `response.flushHeaders()` exists (verified on 24.18.1) — long-standing API.
- Defaults verified on 24.18.1 (`new http.Server()`): `timeout: 0` (no socket-inactivity cap — an open stream is never killed by it), `keepAliveTimeout: 5000`, `headersTimeout: 60000`, `requestTimeout: 300000`, `connectionsCheckingInterval: 30000`.
  - None of these cap the *duration of an open SSE response*: `headersTimeout`/`requestTimeout` govern receiving the request; `keepAliveTimeout` closes **idle** keep-alive sockets *between* requests.
  - One real interaction to pin: with 20 s long-poll holds (AD-9) and a 5 s `keepAliveTimeout`, the server will routinely close the idle keep-alive socket between polls — the api-client must treat socket close during idle as normal reconnect, not an error event.
- Heartbeat/comment frames remain necessary — not for Node, but for intermediary idle timeouts (Caddy/proxies) — consistent with AD-6's 60 s heartbeat being presence-level; the `/events` SSE stream needs its own shorter keep-alive comment cadence (a proxy-idle window, e.g. ≤ 30 s) or streams through Caddy will be dropped mid-conversation.
- No built-in compression in `node:http`/`node:https`, so there is no gzip-buffering hazard to work around.
- 24.x changelog, keep-alive/SSE-adjacent entries — all fixes/additive: `server.keepAliveTimeoutBuffer` (24.6), `Agent.agentKeepAliveTimeoutBuffer` (24.7), keep-alive socket-reuse race fix (24.15), `TCP_KEEPINTVL/TCP_KEEPCNT` in `setKeepAlive` (24.19, net). No default changed.

Optional edit — one line in AD-8 or the Deferred/SSE note:

> SSE pins: `Content-Type: text/event-stream` + `flushHeaders()`; Node defaults (`server.timeout` 0, `keepAliveTimeout` 5 s, `requestTimeout` 300 s) do not cap an open stream; keep-alive comment frames ≤ 30 s defeat intermediary idle timeouts; idle-socket closure between 20 s long-polls is expected and handled client-side.

Sources:
- Local defaults probe on 24.18.1 (values above)
- CHANGELOG_V24.md http/net sections (list above)
- https://nodejs.org/docs/latest-v24.x/api/http.html (flushHeaders, server timeout semantics)

## Claim 5 — Everything else in the spine asserted as current

**5a. Caddy (AD-11) — Confirmed.** Latest release v2.11.4 (2026-06-03); no Caddy 3 exists. The "documented reverse-proxy recipe (Caddy)" reference is current. Source: https://github.com/caddyserver/caddy/releases

**5b. MCP stdio as the only agent-facing surface (AD-1/AD-3) — Confirmed, but unpinned.** The MCP spec has moved three times since the 2025-06-18 baseline: 2025-06-18 → 2025-11-25 → **2026-07-28 (current latest tag)**. The spine never names a revision, so nothing is *stale*, but "MCP stdio" is a moving target; the PRD or spine should pin the targeted revision (2026-07-28) so the adapter's framing/tooling contract is testable. Source: https://github.com/modelcontextprotocol/modelcontextprotocol/tags

**5c. `randomBytes`, `timingSafeEqual`, SHA-256 (AD-11) — Confirmed.** No breaking changes anywhere in 24.x. Only relevant entries: the timingSafeEqual validation fix (24.12.0, PR #60538) and a timing-safety hardening of *WebCrypto* HMAC/KMAC (CVE-2026-21713, 24.14.1) — the latter does not touch `crypto.timingSafeEqual` or Ed25519. Local execution on 24.18.1 confirms all three primitives.

**5d. Checked and found no other technology claims in the spine.** The remaining stack rows (vanilla HTML/CSS/JS viewer, native ESM, `node:test`) make no currency claim that can go stale.

---

## Limits of this review

- Local execution evidence is from one build (v24.18.1, darwin arm64, official); bundled-SQLite mapping for other 24.x is from the changelog, not per-version downloads. Custom Node builds with `--shared-sqlite` can report any version — which is exactly why the runtime assert (rather than a Node-version table) is the right mechanism, and why the Stack-table edit above says "on stock Node builds."
- The WebSearch tool was rate-limited (429) throughout; all verdicts above are grounded in fetched primary sources and local probes instead. One discarded search-fallback claim ("node:sqlite stable in Node 24") contradicted the primary sources and was not used.
- Not covered (out of lens): MCP/Claude plugin manifest spec conformance details, Caddy config specifics, non-technology claims.
