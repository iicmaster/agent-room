# REL-3 soak attempts against the re-cut candidate

Each attempt is kept under its own name. **An attempt is not a pass until its own
record says `status: pass`** — a later attempt never inherits an earlier attempt's
verdict, and an attempt that failed is never relabelled.

| Attempt | Candidate | Result | Where |
|---|---|---|---|
| 1 | `7dc980f` | **PASS** — 481.5 min, candidate-exact, zero loss over 22,625 messages, FD stable, final-window RSS pass | `docs/release-evidence/v0.2.0-soak-results.{json,md}` (the release candidate this attempt pinned) |
| 2 | `89c8477` (the re-cut) | **FAIL** — 481.5 min tracked, candidate-exact, zero loss over 22,615 messages, FD stable, but the final-window RSS total-growth bound was exceeded | `attempt2-89c8477.{json,md}` |
| 4 | `3929cc7` (the final candidate) | **FAIL** — 482.66 min tracked, candidate-exact, **zero message loss** (23,080 acknowledged == 23,080 readable, 0 duplicates, 0 lost), FD stability PASS (worst drift 1 of a ±5 corridor), and ONE failing rule: the final-window RSS total-growth bound (113.9 MiB → 116.5 MiB, `growthRatio` 0.02239 against the 0.02 bound; the slope's implied growth 0.03988). The host was quiet throughout (the external telemetry sidecar is kept beside the run) | `attempt4-3929cc7.{json,md}` + `attempt4-3929cc7-telemetry.log` |
| 3 | `89c8477` (the re-cut) | **SUPERSEDED — stopped short of its 8 h** (191 min tracked; stopped 2026-10-21T10:41Z with the candidate already void) on a quiet host, because the lease-defect review placed a shipped-code fix inside v0.2.0's scope, which changes packaged bytes and voids the candidate. Its RSS trace is the evidence that the attempt-2 failure was host contention: on the quiet host the server sat at 90–117 MiB with **no sawtooth at all** (attempt 2 oscillated 25↔94 MiB) | `attempt3-quiet-host-telemetry.log` (the external host-telemetry sidecar: load, memory available, node process count, server RSS, `pgmajfault` every 60 s) |

Attempt 2's own failure reason, verbatim from its record:

```
final-window RSS growth above the 2% total-growth bound
```

with `growthRatio` 1.7003 and `impliedGrowthRatio` 2.1381 against a 0.02 bound
(window start 30.5 MiB → window end 82.4 MiB).

Attempt 2 was run on a workstation that was simultaneously running the full test
suite, a second compressed-soak validation, and a vendor-CLI demo — the advisor
review had warned against exactly that ("do not start heavy concurrent
qualification work on the soak host without establishing that contention will
not distort the run"). Attempt 1 ran on a quiet host.

**What the samples do and do not show.** Both runs' RSS is a 60-sample sawtooth
(~25 MiB) whose step up lands exactly on the hourly reconnect's ~1008 token
mints, and attempt 1's final window opened at 74.95 MiB and closed at 52.9 MiB
(−29.5%) while attempt 2's opened at 30.5 MiB and closed at 82.4 MiB (+170%).
An earlier note in this file explained attempt 2's failure as "unlucky phase"
between two endpoints of a sawtooth. **The advisor's statistical review
refutes that explanation** (see
`docs/implementation/reviews/epic-6-soak-rss-astra.md`): comparing attempt 2's
last sixty samples against its first sixty at MATCHED phase, every one of the
sixty differences is positive (minimum +24.33 MiB, mean +45.15 MiB) — a
sustained rise, not a phase artifact. A median would not remove it either.

Two things are therefore established and two are not:

- **Established:** the rule was applied correctly (both verdicts replay
  exactly from the stored samples with the shipped evaluator); the server's
  identity was candidate-exact; zero message loss and FD stability held in both
  attempts; and the server-side diff between the two candidates is one line —
  `APP_VERSION`'s literal in `server/runtime.mjs`.
- **Not established:** whether the rise is a product defect (memory retained by
  the server's session-token handling) or a host artifact (the workstation was
  running the full test suite, a second compressed soak, and a vendor-CLI demo
  during attempt 2 — the same interference the prior review warned against).
  Neither a leak nor benign reclamation is proven, and the GC hypothesis is
  currently a hypothesis: the tracker records the server PID's OS RSS and FD
  count, and no GC events, retained heap, or external allocation series.
