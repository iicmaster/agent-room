---
title: 'The fence never lies — A5 post-input revalidation, A7 unexhaustible retention, the two comment corrections'
type: 'feature'
created: '2026-10-26'
status: 'draft-pending-the-epic-7-design-gate'
baseline_revision: 'working-tree on 8a13348 (Epic 7 authored; this spec drafted before the design gate returns — its mechanism choices are the thing the gate rules on)'
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/epics.md (Story 7.1)'
  - '{project-root}/docs/implementation/reviews/epic-6-release-gate-codex.md (the executed A5/A7 findings)'
  - '{project-root}/docs/implementation/reviews/epic-6-release-gate-2026-10-25-resolution.md (the recorded comment corrections)'
  - '{project-root}/server/api/pipeline.mjs (the stage sequence, readRequestFields, runPipeline)'
  - '{project-root}/server/api/session.mjs (the superseded fence, the two comments)'
  - '{project-root}/tests/session-replacement.test.mjs (the row that pins the old gap)'
problem: |
  Two executed findings and one recorded decision define this story exactly:

  - **A5** — the handoff fence is checked at the authorization stage, which runs
    BEFORE a body-carrying route's body is read, so a request admitted before a
    takeover whose body was still arriving can still reach the handler. The
    release owner accepted the reduced semantics for v0.2.0 and recorded the
    stronger clause — revalidating the session authority after the LAST awaited
    input step, directly before the mutation — as this release's first
    acceptance criterion (docs/epics.md Story 6.4's corrected clause).
  - **A7** — the `superseded` fence is bounded at 1,000 entries, so a 1,001st
    supersession can forget a still-admitted predecessor: a count bound proves
    nothing about in-flight requests.
  - **The two comments** — `server/api/session.mjs`'s fenced-set comment claims
    an evicted fence "can no longer describe a request still in flight" (false
    under A7), and `isSuperseded`'s comment claims the pipeline asks it
    "immediately before the handler runs" (false for body-carrying routes under
    A5). The v0.2.0 release shipped them under a recorded threshold acceptance;
    v0.3 corrects them at the root, with the behavior they describe.
approach: |
  **1. The post-input revalidation (A5).** In `runPipeline`, after the stage
  loop completes and `readRequestFields` resolves (the last awaited input step
  for every route — bodyless routes set an empty body there), and directly
  before `handler(context)` is invoked, re-run the handoff-fence check:
  `sessionRegistry.isSuperseded(context.session?.sessionKey)` → reject
  `unauthorized` on a fenced key. This makes the corrected Story 6.4 clause
  literally true for EVERY route (a bodyless route already passed the stage
  check microseconds earlier; re-checking it is strictly better and costs one
  Map lookup). The re-validation re-runs the FENCE only — the ban check is a
  policy gate whose semantics were not in the executed finding, and widening
  it is a decision for its own story, not this one.

  **2. Unexhaustible retention (A7) — the mechanism this spec proposes for the
  design gate.** The fence entry for a displaced session key may be DROPPED
  only when it is provably safe: no request holding that key can still be
  inside the admission→handler window. Mechanism: a per-sessionKey live-request
  count, incremented in `runPipeline` after the stage loop completes (all
  stages passed = admitted), decremented in a `finally` that covers every exit
  path (rejection, refusal, handler result, error, the HANDLER_STREAMED
  sentinel). A superseded key's fence entry survives while its live count is
  above zero; eviction (oldest-first, on insert) considers only entries whose
  live count is zero; the hard 1,000 bound becomes a GENEROUS safety cap
  (10× the registry's maxSessions) whose overflow REFUSES the supersession
  loudly (`fence_overflow`) rather than silently forgetting a live predecessor
  — a takeover that cannot be fenced safely must not happen. A displaced
  token can never authenticate again, so a live count only falls: the fence
  drains, and memory stays bounded by genuinely in-flight displaced requests.

  **3. The comments state the repaired truth.** The fenced-set comment
  describes the in-flight-counted retention; `isSuperseded`'s comment states
  the true placement (the authorization stage AND the post-input revalidation
  directly before the handler). No other prose rides with this story.

  **4. The pinned gap flips.** The test row in
  `tests/session-replacement.test.mjs` that pins the 1,000-entry forget as a
  KNOWN LIMITATION is rewritten to pin the closed behavior: supersessions
  beyond the old bound with live in-flight requests keep every one of them
  fenced; supersessions beyond the bound with NO in-flight requests still
  evict (the memory bound is real, and now provably safe).
acceptance_criteria: |
  | # | Given | When | Then |
  |---|---|---|---|
  | 1 | A request admitted before a same-Actor takeover, its body still arriving | the body completes after the handoff | the post-input revalidation refuses it (`unauthorized`) at the fence — the handler never runs (the executed gap, closed) |
  | 2 | The same request | the handoff lands after its revalidation | it completes (the check is a point-in-time truth, not a retroactive one) |
  | 3 | More supersessions than the old bound, each displaced session holding a live in-flight request | the fence is queried for every displaced key | every one is still fenced — retention is unexhaustible |
  | 4 | More supersessions than the old bound, none in flight | the fence is queried | the oldest entries were evicted (the memory bound holds, safely) |
  | 5 | The safety cap overflowing with ALL entries live | a new supersession is requested | it is refused loudly (`fence_overflow`) — never a silent forget |
  | 6 | The shipped source | read | both comments state exactly the repaired behavior; no other prose changed |
files: |
  - `server/api/pipeline.mjs` — the post-input revalidation in `runPipeline`; the live-request register/release around it (finally-covered).
  - `server/api/session.mjs` — the fence's eviction policy (safe-only), the safety cap and its loud refusal, both comment corrections.
  - `tests/session-replacement.test.mjs` — the gap-pinning row flips; new rows for the five AC behaviors above.
  - `tests/pipeline.test.mjs` (or its home) — the admission→refusal window test with a drip-fed body.
schedule: |
  1. The design gate: this spec's A7 mechanism (and the A5 placement) ratified or refused by the two vendor lanes; refusals rewrite this spec BEFORE the build starts.
  2. The build: pipeline revalidation + registry retention + comments + tests.
  3. `node --test --test-concurrency=1 --test-timeout=600000` (the suite's standing 600 s rule) — full suite green.
  4. bmad-review over the diff, weighted to the seams (pipeline × session registry × routes).
  5. sprint-status: `7-1-the-fence-never-lies` → done.
notes: |
  - The suite's concurrency/timeouts per [[agent-room-suite-timeout-600s]].
  - HANDLER_STREAMED: the finally releases the count when runPipeline returns,
    which is at stream START for a streaming handler — over-retention is not
    produced; a live SSE stream does not re-run the pipeline, so the fence's
    job for it belongs to the displacement itself, not to this story.
