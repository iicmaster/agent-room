# REL-3 soak attempts against the re-cut candidate

Each attempt is kept under its own name. **An attempt is not a pass until its own
record says `status: pass`** — a later attempt never inherits an earlier attempt's
verdict, and an attempt that failed is never relabelled.

| Attempt | Candidate | Result | Where |
|---|---|---|---|
| 1 | `7dc980f` | **PASS** — 481.5 min, candidate-exact, zero loss over 22,625 messages, FD stable, final-window RSS pass | `docs/release-evidence/v0.2.0-soak-results.{json,md}` (the release candidate this attempt pinned) |
| 2 | `89c8477` (the re-cut) | **FAIL** — 481.5 min tracked, candidate-exact, zero loss over 22,615 messages, FD stable, but the final-window RSS total-growth bound was exceeded | `attempt2-89c8477.{json,md}` |

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

The RSS series of BOTH attempts shows the same sawtooth: the hourly reconnect
cycle (which mints ~1008 session tokens to arm the eviction path) is followed by
a step up of roughly 25 MiB and a decay back over the hour. Attempt 1's final
four-hour window happened to open near a peak and close near a trough (growth
−29.5%); attempt 2's window opened one minute after a reconnect (trough, 30.5
MiB) and closed on the next reconnect (peak, 82.4 MiB), so the same rule read
+170%. See `docs/implementation/reviews/epic-6-soak-rss-astra.md` for the
advisor's reading of that.
