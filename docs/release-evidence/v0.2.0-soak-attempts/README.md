# REL-3 soak attempts against the re-cut candidate

Each attempt is kept under its own name. **An attempt is not a pass until its own
record says `status: pass`** — a later attempt never inherits an earlier attempt's
verdict, and an attempt that failed is never relabelled.

| Attempt | Candidate | Result | Where |
|---|---|---|---|
| 1 | `7dc980f` | **PASS** — 481.5 min, candidate-exact, zero loss over 22,625 messages, FD stable, final-window RSS pass | `docs/release-evidence/v0.2.0-soak-results.{json,md}` (the release candidate this attempt pinned) |
| 2 | `89c8477` (the re-cut) | **FAIL** — 481.5 min tracked, candidate-exact, zero loss over 22,615 messages, FD stable, but the final-window RSS total-growth bound was exceeded | `attempt2-89c8477.{json,md}` |
| 4 | `3929cc7` (the final candidate) | **FAIL** — 482.66 min tracked, candidate-exact, **zero message loss** (23,080 acknowledged == 23,080 readable, 0 duplicates, 0 lost), FD stability PASS (worst drift 1 of a ±5 corridor), and ONE failing rule: the final-window RSS total-growth bound (113.9 MiB → 116.5 MiB, `growthRatio` 0.02239 against the 0.02 bound; the slope's implied growth 0.03988). The host was quiet throughout (the external telemetry sidecar is kept beside the run) | `attempt4-3929cc7.{json,md}` + `attempt4-3929cc7-telemetry.log` |
| 3 | `89c8477` (the re-cut) | **SUPERSEDED — stopped short of its 8 h** (191 min tracked; stopped 2026-10-21T10:41Z with the candidate already void) on a quiet host, because the lease-defect review placed a shipped-code fix inside v0.2.0's scope, which changes packaged bytes and voids the candidate. Its RSS trace is what a quiet host looks like — the server sat at 90–117 MiB — and that is a CONTEXT, not a proof: it is a 191-minute window on a different candidate, not a controlled comparison with attempt 2 | `attempt3-quiet-host-telemetry.log` (the external host-telemetry sidecar: load, memory available, node process count, server RSS, `pgmajfault` every 60 s) |
| 6 | `3929cc7` (the final candidate) | **PASS — the release evidence** — 724.61 min tracked, `candidate-exact`, **zero message loss** (33,725 acknowledged == 33,725 readable, 0 duplicates, 0 lost), FD stability PASS (worst drift 1 of a ±5 corridor over 661 post-baseline samples), the final-window RSS rule PASS (the window's RSS FELL −1.86%, growthRatio −0.0186 against 0.02; the slope's implied growth 0.0056 against the same bound) under the amended protocol, and the host window adjudicated **`eligible`** under the frozen, digested quiet-host contract (coverage 1.0, 239/240 samples, median 0.449 / mean 0.446 cores against the frozen 1.345 / 1.576, foreign processes ≤ 4 against 7, MemAvailable ≥ 6.54 GiB, zero gaps, the thresholds digest matching at the launch and at the scoring). The retained-state diagnostic reads RISING (0.65%/hour) — reported, never gated, a finding carried rather than a leak-free claim | `attempt6-3929cc7.{json,md}` + telemetry, census, launch record, adjudication, eligibility and the full `--trace-gc` capture; copied over the release evidence `docs/release-evidence/v0.2.0-soak-results.{json,md}` |
| 5 | `3929cc7` (the final candidate) | **ABORTED — never scored** (130.37 min tracked; aborted by the operator at 2026-10-22T04:47:40Z). The twelve-hour run under the amended protocol, launched 2026-10-22T02:41Z on the quiet host: `candidate-exact`, 7,075 acknowledged messages, RSS 104–108 MiB, FD 22–23, and then stopped on purpose — the pre-registered quiet-host contract turned out to be UNSATISFIABLE on the host it was written for (see below), so no verdict the run could earn was reachable. `status: aborted`, `failureReasons: ["traffic loops did not settle within 60000 ms"]` — which is the teardown's own consequence of the abort, not an independent fault | `attempt5-3929cc7.{json,md}` + `attempt5-3929cc7-telemetry.log` (the run's own sidecar) + `attempt5-3929cc7-soak.log` |

### Attempt 5, and why it was stopped rather than finished

Attempt 5 is the first run under the AMENDED protocol (FR-13's single band, the final four hours,
the twelve-hour shape). It was stopped 130 minutes in, by the operator, for a reason that has nothing
to do with the server: **the quiet-host contract that the amendment pre-registered could never be
satisfied on the host the soak runs on.**

Two of its three clauses were mis-specified, and both were measured rather than argued:

- *"no node process other than the run's own server, its four clients and the recorder"* — ngs-staging
  carries **seven** foreign node processes of its own (a model gateway, two MCP servers with their npm
  wrappers, a `next-server`, and the codex app-server). They were present during every attempt,
  including attempt 4. A clause that can never be satisfied disqualifies every attempt equally: it
  measures the HOST, not the run.
- *"the maximum 1-minute load ≤ 2.0"* — with the run in flight the host's CPU was **over 90% idle**
  while the 1-minute load sat between 1.2 and 1.9 and spiked to 3.2, because the load average counts
  the run's OWN fsync waits (the store commits with `synchronous=FULL`). Gating on it would have failed
  the run for doing its job.

Letting the run continue would have produced a verdict it could never earn, so it was aborted and its
world kept for autopsy. The contract was then rewritten into a baseline-comparison form
(`docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md`), measured by the
repository's own sidecar `scripts/rel1-soak-telemetry.sh`, and put through a fresh advisor gate before
the next run started. The MEMORY GATE ITSELF is untouched by that correction, and attempt 5 is never
scored.

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

**What is established about attempt 2, and what is not (corrected 2026-10-22).** The archived reviews
do NOT collectively establish host contention as attempt 2's cause: the statistical review showed that
attempt 2's own samples refute the "unlucky phase" explanation, and the attempt-3 quiet-host trace is a
191-minute window on a different candidate, not a controlled comparison. What IS established is narrower
and still enough to matter: attempt 2 was RUN on a workstation that was simultaneously executing the
suite, another soak validation and a vendor demo, while the review had warned against exactly that, and
its samples show a growth the earlier explanation does not cover. Attempt 4 (the final candidate, a
quiet host with its own telemetry) then failed the same rule with the host demonstrably idle, which is
what turned this into a measurement question rather than a contention story — see
`docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md`.

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
