# Advisement Round-Table: REL-3 Soak Attempt 2 Failure on Final-Window RSS (`agy-rss`)

**Seat:** `agy-advisor` (`gemini-4-argon-high`, read-only consultation)
**Candidate under test:** `89c8477` (Attempt 2) vs `7dc980f` (Attempt 1)
**Evidence inspected:** `docs/release-evidence/v0.2.0-soak-results.json` (Attempt 1), `docs/release-evidence/v0.2.0-soak-attempts/attempt2-89c8477.json` (Attempt 2), `.soak-world/soak.log`, `tests/soak/rel3-soak.mjs`, `tests/harness/leak-tracker.mjs`, `server/api/session.mjs`, `server/api/server.mjs`, `server/store/room-log.mjs`, `docs/epics.md`, `docs/prds/prd-agent-room-2026-09-20/prd.md`.

---

## Pre-Table Fact Check: The Brief's "Phase Coin-Flip" Diagnosis Is Refuted by the Stored Samples

Before the voices argue what to do next, the raw sample arrays in `v0.2.0-soak-results.json` and `attempt2-89c8477.json` refute three premises in the brief (`Measured facts` #1, #2, and #3):

1. **Attempt 1 did NOT open its final window at `65.8 MiB`, and Attempt 2 did NOT close on a reconnect at sample `480`:**
   - In Attempt 1, `samples[240]` is `65.8 MiB`, but `samples[480].atMs - samples[240].atMs = 14,400,282 ms > 14,400,000 ms`, so `samples[240]` is excluded by `282 ms`. The final window (`samples[241..480]`, 240 samples) actually opened at `samples[241] = 78,594,048` bytes (**`75.0 MiB`**) and closed at `samples[480] = 55,427,072` bytes (**`52.9 MiB`**), yielding `(52.86 - 74.95) / 74.95 = -29.48%`.
   - Neither run has a reconnect at sample `480`. `tests/soak/rel3-soak.mjs:1384` stops scheduling reconnects at `state.endAt - 900_000 ms`. Both runs execute **7** reconnects (`idx = 60, 120, 180, 240, 300, 360, 420`). Sample `480` is 60 minutes after Reconnect #7 and 9 minutes after Burst #47 (`idx = 471`).
   - Both runs have the **exact same phase geometry** at the window boundaries: `idx = 240` lands mid-reconnect (`+279 ms` in Attempt 1, `+542 ms` in Attempt 2), `idx = 241` lands ~52 seconds after Reconnect #4 finishes, and `idx = 480` lands at the end of Hour 8 with no reconnect.

2. **The regular sawtooth in Attempt 1 has a 10-minute (10-sample) period driven by `burstLoop` + `readLoop`, not only a 60-minute reconnect period:**
   - In Attempt 1, there are 42 sample-to-sample jumps `> 8 MiB`. **40 of those 42 jumps occur at `idx % 10 === 1`** (`idx = 61, 91, 101, 111, 121, 131, ..., 471`), including `+25.0 MiB` at `idx = 191`, `+26.7 MiB` at `idx = 251`, `+27.7 MiB` at `idx = 401`, and `+26.7 MiB` at `idx = 471` where no reconnect occurred. Every 10 minutes (`burstEveryMs = 600,000 ms`), `burstLoop` sends `150 × 32 KiB` messages (`4.8 MiB` raw payload) and the four clients' `readLoop`s paginate them (`READ_PAGE_DEFAULT = 50`).

3. **Attempt 2 did NOT fail because of endpoint phase; it experienced a macroscopic regime shift (U-shaped trajectory across the 8 hours) and fails every phase-robust statistic by `>135%`:**

| Metric | Attempt 1 (`7dc980f`) | Attempt 2 (`89c8477`) |
|---|---|---|
| Hourly medians H1..H4 (MiB) | `66.2, 67.2, 69.4, 71.1` | `39.0, 38.8, 38.3, 30.5` |
| Hourly medians H5..H8 (MiB) | `65.6, 61.2, 58.1, 57.6` | `30.3, 25.1, 50.5, 79.1` |
| Hourly means H5..H8 (MiB) | `66.0, 63.9, 61.1, 59.8` | `32.5, 27.2, 53.2, 77.5` |
| 0-Actor `idleFootprint` RSS (boot → H1..H7 → post-drain) | `62.7 → 61.7, 62.3, 61.6, 59.1, 60.0, 58.0, 57.0 → 163.9 MiB` | `62.6 → 38.8, 38.3, 38.2, 30.2, 25.0, 25.0, 81.4 → 162.3 MiB` |
| Final-window endpoint `growthRatio` (`s[241]` → `s[480]`) | **−29.48%** (`75.0 → 52.9 MiB`) | **+170.03%** (`30.5 → 82.4 MiB`) |
| Final-window 240-sample OLS `impliedGrowthRatio` (4.00 hourly periods) | **−12.59%** (`-0.690 B/ms`) | **+213.81%** (`+4.768 B/ms`, `+68.4 MiB`) |
| Phase-robust H5 → H8 **hourly median** growth | **−12.3%** (`65.6 → 57.6 MiB`) | **+161.1%** (`30.3 → 79.1 MiB`) |
| Phase-robust H5 → H8 **hourly mean** growth | **−9.4%** (`66.0 → 59.8 MiB`) | **+138.6%** (`32.5 → 77.5 MiB`) |

In Attempt 2, starting at `idx = 380` (`02:12:32 UTC` / `09:12:32 +07:00`, 20 minutes after Reconnect #6 — not on a reconnect), baseline RSS climbed from `25.1 MiB` (`idx = 379`) to `38.0 → 50.5 → 66.3 → 79.3 → 94.0 MiB` (`idx = 411`) and stayed between **`64.7 MiB` and `93.9 MiB` (median `79.1 MiB`)** for the entire final hour (`idx = 420..480`).

---

## The Round-Table

### Dana (Statistical & Performance Engineer): "Stop blaming sawtooth phase — Attempt 2 had a 3x baseline regime shift, AND `rel3-soak.mjs` still has a formula bug"

Let us get the math straight first. The brief's hypothesis — that Attempt 1 and Attempt 2 have the same stationary sawtooth and Attempt 2 only lost a phase coin-flip at `s[241]` and `s[480]` — is completely falsified by the stored time series.

Look at the hourly medians in Attempt 2:
- Hours 1–3 sit at `39.0, 38.8, 38.3 MiB`.
- Hours 4–5 drop to `30.5, 30.3 MiB`.
- Hour 6 drops to `25.1 MiB` (with 50 of 60 samples pinned at `25.0–25.5 MiB`).
- Then at sample `380` (minute 380, twenty minutes after Reconnect #6), the floor lifts continuously across four 10-minute bursts (`25.1 → 38.0 → 50.5 → 66.3 → 79.3 → 94.0 MiB`) and never comes back down. Every single sample in Hour 8 (`idx = 420..480`) sits between `64.7 MiB` and `93.9 MiB` with a median of `79.1 MiB`.

That means if you replace the rule today with **Option B** — per-hour medians, per-hour means, or whole-period regression over the 4 full hourly cycles in the 240-sample window — **Attempt 2 still fails by +161.1% (hourly medians), +138.6% (hourly means), and +213.8% (4-period OLS)!** Even if you normalize the OLS growth (`+68.4 MiB`) by the post-warmup initial RSS `samples[0] = 81.2 MiB` instead of `samples[241] = 30.5 MiB`, it is still `+84.2%` against a `2%` bound.

**However**, once we recognize that Attempt 2 is a non-stationary, host-contaminated run, look at `tests/soak/rel3-soak.mjs:987-1005`. The PRD (`docs/prds/prd-agent-room-2026-09-20/prd.md:239`) states:
> *"memory within the SM-3 noise band (RSS least-squares slope over the final four hours ≤2% of starting RSS) — this band is the single pass rule; no story may impose a stricter or looser memory criterion."*

Yet `evaluateFinalWindowRss` in `rel3-soak.mjs:1005` enforces:
```js
evaluation.pass = growthRatio <= FINAL_WINDOW_GROWTH_BOUND && impliedGrowthRatio <= FINAL_WINDOW_GROWTH_BOUND
```
where `growthRatio = (endRssBytes - startRssBytes) / startRssBytes` is a two-point instantaneous difference (`s[480] - s[241]`), and `startRssBytes` is `s[241]`. Even on a quiet host where the 4-hour OLS slope is negative (like Attempt 1), `burstLoop` creates `+15` to `+27 MiB` spikes every 10 minutes (`idx % 10 === 1`). Because `burstLoop` sleeps `600,000 ms` *after* each burst finishes (plus reconnect pauses), burst phase drifts slowly across the 8 hours relative to the 60s sampler. If a quiet Attempt 3 happens to have Burst #47/48 land on `s[480]` while `s[241]` lands off-burst, `growthRatio` will fail a run whose OLS slope (`impliedGrowthRatio`) is `0.00%`! That two-point `growthRatio` check is an unratified addition in `rel3-soak.mjs` that violates FR-13's prohibition against imposing a stricter memory criterion than the least-squares slope.

---

### Grumbal (The Adversary): "Dana just proved Option B is an excuse — and touching `rel3-soak.mjs` after a FAIL is goalpost-moving!"

**Dana**, listen to what you just proved! You proved that Attempt 2 did NOT fail because of `growthRatio` vs `impliedGrowthRatio`. In Attempt 2, `impliedGrowthRatio` (the pure 240-sample least-squares slope over 4 exact hourly periods) was **`+213.81%`** (`+4.77 bytes/ms`, `+16.4 MiB/hour`), more than **100×** the `2%` bound!

And yet you want to open `tests/soak/rel3-soak.mjs` and edit `evaluateFinalWindowRss` right after a red gate?! **Absolutely not.**

Let me tell the room what actually happened here:
1. In our earlier Epic 6 review, we explicitly warned the operator: do not run heavy concurrent qualification work on the soak host while the 8-hour soak is running.
2. At `02:52 +07:00` (`19:52Z`), Attempt 2 was launched. Between `02:53` and `03:46 +07:00` — right in Hour 1 of Attempt 2 — the operator ran the packaged-viewer preflight, the Zcode lab setup, the 555-test suite (which hung/ran so long it blew the 300s timeout, see commit `809d080` at `03:46 +07:00`), and a second 5-minute 4-client compressed soak!
3. Look at the server CPU time recorded in `idleFootprint`: Attempt 1 used `6.63s` of CPU in Hour 1 and `56.72s` total. Attempt 2 used `9.46s` in Hour 1 (+43%) and `73.25s` total (+29%) for the *exact same* 22,615 messages!
4. When Attempt 2 failed at `10:53 +07:00`, instead of plotting the 481 samples, the operator looked at two numbers (`241` and `480`), invented a comforting fairy tale about "60-sample reconnect sawtooth phase," and came asking for permission to rewrite the measurement rule (**Option B**) or blame a 1,008-token loop (**Option C**)!

If you change the measurement rule in `rel3-soak.mjs` right after a failed run — when the failed run wouldn't even pass your new rule! — you are engaging in **audit theater**. You never rewrite a gauge to clear a contaminated experiment. First you re-run the experiment cleanly (**Option A**), on a machine where nobody touches a terminal for 8 hours!

---

### Winston (Systems Architect): "Let's explain the physics of the `25 MiB → 79 MiB` curve AND the `session.mjs` allocation spike — and why Option C is a trap"

Both **Dana** and **Grumbal** are right about the numbers, so let me explain the systems physics of *why* Attempt 2 produced `81.2 → 38.8 → 30.3 → 25.0 → 79.1 MiB`, and what is actually happening inside `server/api/session.mjs`.

First, look at **Option C** (the hourly reconnect's 1,008 token mints). I inspected `server/api/session.mjs:71-80`:
```js
for (const [digest, entry] of sessions) {
  if (entry.expiresAt <= timestamp) sessions.delete(digest)
}
while (sessions.size >= maxSessions) {
  const oldestExpired = [...sessions.entries()].find(([, entry]) => entry.expiresAt <= timestamp)
  sessions.delete(oldestExpired ? oldestExpired[0] : sessions.keys().next().value)
}
```
Look closely at lines 71–80:
- Lines 71–73 **already delete every expired entry** at `timestamp`.
- Therefore, in line 78, `oldestExpired` is **always `undefined`**. Yet `[...sessions.entries()]` spreads all 1,000 Map entries into a fresh 1,000-element Array of `[key, value]` tuples on every `issue()` once `sessions.size === 1000`.
- During `evictChildSessionTokens()`, the harness fires `1,008` sequential `POST /api/auth/local` calls in `~1.2s`. Each call also reads `local-token` from disk and executes a synchronous SQLite `BEGIN IMMEDIATE ... INSERT INTO enrolled_actors ... COMMIT` (`server/api/server.mjs:330`).
- Because `s[60*k]` is sampled at `rStart + 162..849 ms` (right in the middle of those 1,008 mints), `ps -o rss=` catches `~24–25 MiB` of uncollected V8 young/old-space garbage (`s[240] = 55.5 MiB`, `s[300] = 49.0 MiB`, `s[360] = 50.4 MiB` in Attempt 2).
- **Is that a memory leak?** **No.** Look at `idleFootprint` in Attempt 2, which samples RSS at `rStart + ~15 ms` (just before the 1,008 mints) and again 2 seconds *after* the reconnect finishes:
  - R4: pre-mint `30.2 MiB` → mid-mint `s[240] = 55.5 MiB` → post-reconnect `30.3 MiB` → `s[241] = 30.5 MiB`.
  - R5: pre-mint `25.0 MiB` → mid-mint `s[300] = 49.0 MiB` → `s[301] = 25.1 MiB`.
  - R6: pre-mint `25.0 MiB` → mid-mint `s[360] = 50.4 MiB` → post-reconnect `25.3 MiB`.
  The live `sessions` Map is strictly bounded at `SESSIONS_MAX = 1000` (`~150 KiB`), and V8 GC reclaims the `25 MiB` transient within 2 seconds. Touching `server/api/session.mjs` (**Option C**) to delete the redundant `[...sessions.entries()].find(...)` is a fine 2-line cleanup for v0.2.1, but doing it now **voids candidate `89c8477`**, invalidates Story 6.3 and Story 6.1 evidence, and **would not have prevented Attempt 2's failure**, because Attempt 2's Hour 8 stayed at `64.7–93.9 MiB` for all 60 minutes, not just at reconnect!

Second, why did Attempt 2 drop from `81.2 MiB` (`s[0]`) to `38.8 MiB` (`H1–H3`), `30.3 MiB` (`H4–H5`), and `25.0 MiB` (`H6`), and then return to `79.1 MiB` (`H8`)?
On macOS (`darwin 25.6.0 arm64`), `ps -o rss=` reports `resident_size` — physical pages currently resident in uncompressed RAM. When the host ran 555 test processes + a second 5-minute 4-client soak + vendor CLIs during Hour 1, macOS's Mach `vm_compressor` swept the soak server's cold anonymous pages (V8 old-space pages allocated during warmup, Buffer slabs, SQLite heap) into compressed memory. That artificially depressed `ps -o rss=` to `25–30 MiB` through Hour 6 (`idx = 241` = `30.5 MiB`). Then at `idx = 380` (`09:12 +07:00`), as the SQLite WAL/DB grew toward `1.1 GiB` under sustained 32 KiB bursts and V8 performed major mark-compact / old-space expansion on an uncontended morning host, the server faulted its normal working set back into resident RAM (`65–94 MiB`, the exact same ceiling Attempt 1 occupied for all 8 hours: Attempt 1 max `92.5 MiB` in-run, `163.9 MiB` post-drain vs Attempt 2 max `94.0 MiB` in-run, `162.3 MiB` post-drain).

---

### John (PM): "Protect the candidate, reject Option C, and do not touch the AC rule unless a clean run proves the rule is at fault"

Let's look at the release governance and cost of each option:

- **Option C (Change `server/` product code) is rejected.** Both Attempt 1 and Attempt 2 proved zero message loss (`22,625` and `22,615` messages byte-exact), rock-solid FD stability (`±2` against `±5`), and identical peak memory (`92.5 MiB` vs `94.0 MiB` in-run; `163.9 MiB` vs `162.3 MiB` post-drain). As **Winston** showed, `server/api/session.mjs` does not leak; its `SESSIONS_MAX = 1000` cap holds. Modifying `server/` now triggers the Candidate Immutability Law, destroys candidate `89c8477`, and throws away the re-cut validation and cross-machine evidence for zero user value.

- **Now between Option A (Re-run on a quiet host, unchanged rule) and Option B (Change the measurement rule first):**
  **Dana**, I hear your critique that `rel3-soak.mjs:1005` added an instantaneous endpoint check (`growthRatio <= 0.02`) alongside the PRD's least-squares slope check (`impliedGrowthRatio <= 0.02`), and that normalizing by `windowSamples[0]` (`s[241]`) makes the percentage sensitive to whether `s[241]` was compressed.
  **But Grumbal is right on governance:** we cannot ratify a rule change (Option B) on the back of a contaminated run that failed *every* statistical measure (`+213.8%` OLS slope, `+161.1%` hourly median growth). If we change `rel3-soak.mjs` now and Attempt 3 passes, a skeptical auditor will rightly say we weakened the gate after a failure.
  Wait — **Dana**, what if we run Attempt 3 on a strictly quiet host with `rel3-soak.mjs` untouched (**Option A**), and pre-commit to the exact decision tree before launching?
  1. On a quiet host (like Attempt 1), `ps -o rss=` is never crushed to `25–30 MiB` by concurrent test-suite contention, so the `30 → 80 MiB` regime shift disappears.
  2. What is the real probability that a quiet run fails the instantaneous `growthRatio` check even when `impliedGrowthRatio` (OLS slope) passes?

---

### Dana (Statistical & Performance Engineer): "John, I checked the burst phase in Attempt 1 — here is why Option A alone is a gamble if `burstLoop` drifts onto `s[480]`"

**John** and **Grumbal**, don't guess — look at the numbers in Attempt 1 (`v0.2.0-soak-results.json`)!
Why did Attempt 1 pass `growthRatio` (`-29.5%`)?
Because in Attempt 1:
- `s[241]` (`mod10 = 1`) happened to catch the **peak** of Burst #24 + Reconnect #4 (`75.0 MiB`, while `s[239]` was `59.4 MiB` and `s[245]` was `60.8 MiB`)!
- And `s[480]` (`mod10 = 0`) happened to catch the **trough** 9 minutes after Burst #47 (`52.9 MiB`, while `s[471]` was `80.9 MiB`)!
Had `s[241]` landed in a normal inter-burst trough (`~59.4 MiB`) and `s[480]` landed on a normal 10-minute burst peak (`~80.9 MiB`), then **even in Attempt 1 (on a quiet host!)**, the raw two-point `growthRatio` would have been `(80.9 - 59.4) / 59.4 = +36.2% → FAIL`, even though Attempt 1's hourly medians declined from `65.6 MiB` to `57.6 MiB` (`-12.3%`)!

Even better: what if in Attempt 1, `windowSamples` had started 2 samples earlier at `s[239] = 59.4 MiB`? Look at Attempt 1's OLS slope from `s[239]` or `s[240]`: Attempt 1's OLS slope is negative (`-12.6%`) because the hourly baseline drifted down from `65.6 MiB` (Hour 5) to `57.6 MiB` (Hour 8).
So on a quiet host:
- **OLS slope (`impliedGrowthRatio`)** over 240 samples (24 full 10-minute burst periods and 4 full 60-minute reconnect periods) is naturally resilient to the 10-minute and 60-minute cycles because 240 samples is an **exact integer multiple** of both periods (`240 = 24 × 10 = 4 × 60`)!
- **The raw two-point endpoint difference (`growthRatio = (s[480] - s[241]) / s[241]`)** is NOT resilient — it compares `idx = 241` (`mod10 = 1`, post-burst/post-reconnect) against `idx = 480` (`mod10 = 0`, pre-burst), and it was **never in the PRD or `docs/epics.md`**! Look at `docs/epics.md:39`:
  `RSS least-squares slope over final four hours ≤2% of starting RSS. The single memory pass rule (FR-13/NFR-6 aligned).`
  `rel3-soak.mjs:1005` invented `growthRatio <= 0.02` out of thin air and AND-ed it with `impliedGrowthRatio <= 0.02`!

---

### Sally (UX & Operator Experience): "You are all ignoring why Attempt 2 got contaminated — an unguarded 8-hour background job on an active dev machine is an operational trap!"

Hold on, **Grumbal**, **John**, and **Dana**. You are arguing about equations and moral purity while ignoring the human/agent workflow failure that just burned 8 hours of wall-clock time!

Why did the operator run `node --test` (555 tests), a compressed soak, and the Zcode CLI demo on the soak host during Hour 1 of Attempt 2?
Because `rel3-soak.mjs` runs silently in the background via `nohup` for **8 hours** on the same workstation (`NSG-Mac-mini.local`) where the agent/operator does all other Epic 6 work! There is:
1. **No host-lock or contention tripwire:** Nothing in the repo warns or refuses when `node --test` or another `runSoak()` is launched while an 8-hour formal soak PID is active on the machine.
2. **No host-pressure telemetry in the soak record:** `rel3-soak.mjs` records the server child's `rssBytes` and `fdCount`, but records **zero** host-level memory pressure or load average (`os.loadavg()`, `vm_stat` compressed pages, or active concurrent `node` process count) per sample. So when the run failed 8 hours later, the operator couldn't see from `v0.2.0-soak-results.md` that Hour 1 load spiked and `vm_compressor` squashed the process to `25 MiB`!
3. **A misleading `soak.log` progress line:** `rel3-soak.mjs:1394` only logs progress every 30 samples (`samples 1, 31, 61, 91, 121...`, which are 0-indexed `s[0], s[30], s[60], s[90], s[120]...`). Because `s[60*k]` lands right inside the 1-second `evictChildSessionTokens()` storm while `s[60*k + 30]` lands in the quiet middle of the hour, `soak.log` alternates `39 MiB, 54 MiB, 38 MiB, 60 MiB, 38 MiB, 64 MiB` — tricking the reader into thinking there is a 1-hour reconnect sawtooth when the actual 481-sample JSON series looks completely different!

If we just do **Option A** ("re-run for 8 hours and hope nobody touches the machine or misreads the log"), we are leaving the exact operational footgun cocked.

---

### Winston (Systems Architect): "Here is Option D — what neither the brief's A, B, nor C saw"

Listen to what happens when we put **Dana's** math, **Grumbal's** audit discipline, and **Sally's** operational reality together. None of pure A, pure B, or pure C is right:
- **Pure Option C is wrong:** `server/api/session.mjs` does not leak (the `25 MiB` mid-eviction spike is reclaimed in `<2s`), and editing `server/` voids candidate `89c8477`.
- **Pure Option B before a clean run is wrong:** Attempt 2 failed the PRD's own 240-sample OLS slope rule by `+213.8%` (`+68.4 MiB`) and hourly medians by `+161.1%` because host contention compressed its baseline to `25–30 MiB` in Hours 1–6 before it re-expanded to `79 MiB` in Hours 7–8. No honest metric can Rescue Attempt 2.
- **Pure Option A without guardrails is incomplete:** While `idx = 241..480` spans an exact integer number of 10-minute bursts (`24`) and 60-minute reconnects (`4`), `rel3-soak.mjs` currently enforces both the PRD's OLS slope (`impliedGrowthRatio <= 0.02`) AND an unratified instantaneous two-point difference (`growthRatio <= 0.02`) normalized by single-point `s[241]`.

So **Option D** is the two-part protocol:
1. **Run Attempt 3 on a strictly isolated, quiet host (`89c8477` unchanged, `rel3-soak.mjs` unchanged)** — zero concurrent test suites, zero compressed soaks, zero CLI demos during the 8-hour window — with an **external read-only sidecar sampler** (a 10-line shell loop outside the repo recording `os.loadavg` / `vm_stat` / `footprint -p <serverPid>` every 60s to `.soak-world/host-telemetry.log`) so host VM compression vs heap allocation is directly measured without touching a single line of repo code.
2. **Pre-declare the Attempt 3 verdict gate before launch:**
   - **Case 1:** Attempt 3 passes `evaluateFinalWindowRss` as written (as Attempt 1 did on a quiet host: `growthRatio = -29.5%`, `impliedGrowthRatio = -12.6%`). Gate closed, zero rule controversy, zero candidate churn.
   - **Case 2:** Attempt 3 on a proven-quiet host passes the PRD's ratified least-squares slope (`impliedGrowthRatio <= 0.02` and hourly-median slope `<= 0.02`) but fails *only* the unratified two-point instantaneous `growthRatio` (`(s[480] - s[241]) / s[241]`) because of single-sample burst jitter at the boundary. Only in that case do we have clean, uncontaminated evidence to align `evaluateFinalWindowRss` with PRD FR-13/SM-3 (gating on least-squares slope / per-hour median slope, reporting `growthRatio` as diagnostic).
   - **Case 3:** Attempt 3 on a proven-quiet host shows a real positive OLS slope (`impliedGrowthRatio > 0.02` across Hours 5–8) with flat `vm_stat` compressor activity. Then — and only then — we have a genuine long-horizon server memory growth issue in Hour 7–8 (e.g. SQLite WAL/mmap/heap growth past 1 GiB DB size) that requires `--heapsnapshot-signal` / product investigation (**Option C**).

---

### Grumbal (The Adversary) vs. Dana (Statistical & Performance Engineer): The Unresolved Clash

**Dana:** "**Winston**, why wait 8 hours to fix a defective formula in `tests/soak/rel3-soak.mjs` when we can already see from `docs/prds/prd-agent-room-2026-09-20/prd.md:239` that `rel3-soak.mjs:1005` deviates from the PRD? Look at `rel3-soak.mjs:987-1005`:
1. The PRD specifies **least-squares slope over the final four hours ≤ 2% of starting RSS** (`FR-13`: *'this band is the single pass rule; no story may impose a stricter or looser memory criterion'*).
2. `rel3-soak.mjs` added `growthRatio <= 0.02` (a 2-point endpoint check that the PRD never asked for) AND used a single noisy point `windowSamples[0].rssBytes` (`s[241]`) as the denominator instead of the regression's fitted window start $\hat{y}(t_{\text{start}})$ or the post-warmup starting RSS `samples[0].rssBytes` (`RSS_0`).
3. Furthermore, `rel3-soak.mjs` is a **test file** (`tests/soak/rel3-soak.mjs`), NOT part of the packaged candidate artifact (`server/`, `web/`, `plugin.json`, `mcp.json`, `package.json`). Fixing `evaluateFinalWindowRss` in `tests/soak/rel3-soak.mjs` does **not** touch the frozen candidate `89c8477` — `establishCandidateIdentity` will still report `candidate-exact`! Why risk burning 8 hours on a quiet host only to get tripped by the unratified 2-point `growthRatio` check?"

**Grumbal:** "Because, **Dana**, the compressed validation test (`tests/soak/rel3-soak.test.mjs`) and Attempt 1 (`7dc980f`) both ran under `tests/soak/rel3-soak.mjs` as ratified in `docs/implementation/spec-6-2-rel-3-the-formal-soak.md`! And look at *why* `s[241]` vs `s[480]` passed in Attempt 1: in an 8-hour run, `s[241]` is ALWAYS `mod10 = 1` (post-burst/post-reconnect) and `s[480]` is ALWAYS `mod10 = 0` (9 minutes post-burst, no reconnect). The phase of `s[241]` and `s[480]` is **not** a random coin flip! It is deterministic: `s[241]` is always high (1 minute after Reconnect #4) and `s[480]` is always low (60 minutes after Reconnect #7), which actually biases `(s[480] - s[241]) / s[241]` *negatively* (`-29.5%` in Attempt 1) on any stationary run!
The ONLY reason Attempt 2 failed is that its baseline RSS rose from `30.3 MiB` in Hour 5 to `79.1 MiB` in Hour 8! If you edit `rel3-soak.mjs` right after a FAIL, you are muddying the audit trail to fix a hypothetical phase problem that is actually biased in your favor (`s[241]` high, `s[480]` low)! Run Attempt 3 on a quiet host with the exact same `rel3-soak.mjs` that passed Attempt 1!"

---

## Where the Voices Cannot Agree (Preserved Without Consensus)

1. **Whether to amend `evaluateFinalWindowRss` in `tests/soak/rel3-soak.mjs` BEFORE launching Attempt 3 (Option B+A) vs. running Attempt 3 with `rel3-soak.mjs` completely untouched (Option A/D):**
   - **Dana** insists that `tests/soak/rel3-soak.mjs:1005` contains a demonstrably unratified second gate (`growthRatio <= 0.02`, comparing two instantaneous points `s[480]` and `s[241]`) that contradicts `prd.md:239` (*"RSS least-squares slope over the final four hours ≤2% of starting RSS — this band is the single pass rule; no story may impose a stricter or looser memory criterion"*), and uses an instantaneous single sample `s[241]` as the denominator instead of the regression intercept $\hat{y}(t_{\text{start}})$ or post-warmup `RSS_0`. Because `tests/soak/rel3-soak.mjs` is outside the packaged candidate (`candidate-exact` is unaffected), Dana wants `evaluateFinalWindowRss` aligned to the PRD's OLS slope (or per-hour median slope) *before* spending 8 more hours.
   - **Grumbal** and **John** refuse to touch `tests/soak/rel3-soak.mjs` before Attempt 3. Grumbal points out that: (a) Attempt 2 failed the OLS slope (`impliedGrowthRatio = +213.8%`) and hourly medians (`+161.1%`) even more badly than it failed `growthRatio` (`+170.0%`), so the rule's endpoint term is not why Attempt 2 failed; and (b) in the 8-hour schedule, `s[241]` (`mod60 = 1`) is deterministically post-reconnect while `s[480]` (`mod60 = 0`) has no reconnect, so phase is deterministic, not a coin flip. Changing the evaluator right after a red run taints the release audit.

2. **Whether the Hour 7–8 step-up in Attempt 2 (`25.1 MiB` at `idx = 379` → `79.1 MiB` median in Hour 8) is 100% explained by Hour 1 host contention + macOS VM compression:**
   - **Winston** argues it is macOS `vm_compressor` squeezing the server's resident set down from `81.2 MiB` to `25.0–38.8 MiB` during/after the Hour 1 contention storm, followed by resident working-set fault-in back to the normal `~80 MiB` ceiling (matching Attempt 1's `75–92.5 MiB` working set and `163 MiB` post-drain footprint).
   - **Grumbal** notes that the Hour 1 contention ended around `03:46 +07:00` (`idx = 54`), yet RSS stayed at `25–30 MiB` for five more hours until `09:12 +07:00` (`idx = 380`) before climbing to `79.1 MiB` and staying at `65–94 MiB` between bursts in Hour 8 (whereas Attempt 1 decayed to `55–60 MiB` between bursts in Hour 8). Without OS VM counters from Attempt 2, Grumbal refuses to take "it was just Hour 1 contention" on faith until a clean Attempt 3 proves that Hours 5–8 stay flat on an uncontended host.

---

## Each Voice's Bottom Line

- **Dana (Statistical & Performance Engineer):**
  1. **Reject the brief's phase diagnosis:** Attempt 2 did not fail because of sawtooth endpoint phase (`s[480]` is not a reconnect; `s[241]` in Attempt 1 was `75.0 MiB`, not `65.8 MiB`; Attempt 2's hourly medians jumped `+161.1%` from `30.3 MiB` in H5 to `79.1 MiB` in H8, and its 4-period OLS slope was `+213.8%`).
  2. **Recommend Option B + quiet Attempt 3:** Before re-running for 8 hours on a strictly quiet host, fix `evaluateFinalWindowRss` in `tests/soak/rel3-soak.mjs:987-1005` so it gates on what `prd.md:239` actually ratified — the least-squares regression slope across the 240-sample final window (`impliedGrowthRatio <= 0.02`, normalized by the regression's fitted start $\hat{y}(t_0)$ or the window median, with `growthRatio` recorded as diagnostic-only). Because `tests/soak/rel3-soak.mjs` is not in the packaged artifact, candidate `89c8477` remains `candidate-exact`.

- **Grumbal (The Adversary):**
  1. **Option A only (with strict host isolation):** Do **not** touch `server/` (Option C) and do **not** touch `tests/soak/rel3-soak.mjs` (Option B). Attempt 2 was contaminated by running 555 tests, a second soak, and a vendor CLI lab on the soak host in direct violation of our earlier Epic 6 warning, and it failed the OLS slope by `+213.8%`.
  2. Re-run Attempt 3 against candidate `89c8477` with the unchanged harness on a genuinely idle host. In `rel3-soak.mjs`, `s[241]` (`mod60 = 1`) and `s[480]` (`mod60 = 0`, no reconnect) are phase-deterministic, not a coin flip: if the server's memory is stationary on a quiet host, it will pass just as Attempt 1 passed (`-29.5%` endpoint, `-12.6%` OLS). If Attempt 3 fails on a quiet host, you have a real runtime memory drift in Hours 7–8 to investigate.

- **Winston (Systems Architect):**
  1. **Reject Option C for v0.2.0:** `server/api/session.mjs:78` has a redundant `[...sessions.entries()].find(...)` after lines 71–73 already swept expired entries, which allocates ~1M short-lived array tuples during the 1,008-mint reconnect burst (`~25 MiB` transient garbage caught at `s[60*k]`), but `idleFootprint` proves V8 reclaims it within 2 seconds and `sessions.size` never exceeds `SESSIONS_MAX = 1000`. Editing `server/` now voids candidate `89c8477` for a non-leak; log it for v0.2.1.
  2. **Execute Option D (Quiet Attempt 3 + external passive OS telemetry):** Run Attempt 3 on a quiet host with candidate `89c8477` and `rel3-soak.mjs` unchanged, accompanied by an external read-only sampler (`vm_stat` / `top -l 1 -pid <serverPid>` / `os.loadavg()` logged outside the repo every 60s) so macOS `vm_compressor` resident-set depression (`25 MiB`) vs V8 heap growth is directly observable.

- **John (PM):**
  1. **Keep candidate `89c8477` frozen (no Option C) and keep `rel3-soak.mjs` unchanged for Attempt 3 (Option A + Winston's passive telemetry D).**
  2. Changing an AC gate (`rel3-soak.mjs`) right after a contaminated run that failed OLS slope by `+213.8%` is bad release governance. Spend the 8 machine hours on an uncontended host. Only if Attempt 3 on a quiet host passes the PRD's OLS slope (`impliedGrowthRatio <= 0.02`) and hourly-median trend (`<= 0.02`) while failing *solely* on the unratified instantaneous `growthRatio` check should you bring Option B back for a targeted sign-off.

- **Sally (UX & Operator Experience):**
  1. **Fix the operational trap before launching Attempt 3 (Option D):** Don't just launch another 8-hour `nohup` job and rely on willpower not to use the machine. Run an external monitor alongside Attempt 3 that records host load average / process count and prints a loud banner (or lockfile check) so no agent or human runs `node --test` or a second soak while the 8-hour run is in flight.
  2. Note for post-v0.2.0 harness ergonomics: `soak.log`'s 30-minute progress line (`checkpointCount % 30 === 1`) samples at `idx = 60*k` (mid-reconnect) and `idx = 60*k + 30` (mid-hour), which visually fabricates a 1-hour sawtooth in the log output and misled the operator's post-mortem.

---

## Plain Statement of What Could Not Be Verified

1. **OS-level virtual memory / compressor counters and V8 heap breakdown during Attempt 2:** `tests/soak/rel3-soak.mjs` only samples `ps -o rss=` and `lsof` FD counts (plus `ps -o cputime=` at idle windows), and server `pid 41533` was terminated at the end of the run. While the git log proves heavy concurrent host activity during Hour 1 (`2026-10-20T19:53Z` to `20:46Z`, commits `0110831`–`809d080`) and `attempt2-89c8477.json` proves the baseline dropped from `81.2 MiB` to `25.0 MiB` before climbing back to `79.1 MiB` at `idx = 380..480` (`02:12Z`–`03:52Z`), we cannot directly inspect macOS `vm_stat` compressed-page counts or V8 old-space committed vs resident bytes for `pid 41533` to prove why the resident re-expansion began specifically at `idx = 380` (`09:12 +07:00` local) rather than earlier in Hours 2–6.
2. **Whether a second quiet-host run always decays between bursts in Hour 8 (`55–60 MiB` as in Attempt 1) vs holding an elevated inter-burst floor (`65–82 MiB` as in Attempt 2's Hour 8):** Only a single uncontended 8-hour run (`Attempt 1`) exists in the evidence record so far.

TEAM_DONE agy-rss
