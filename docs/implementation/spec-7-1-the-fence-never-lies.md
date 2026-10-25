---
title: 'The fence never lies — A5 post-input revalidation, A7 unexhaustible retention, the two comment corrections'
type: 'feature'
created: '2026-10-26'
status: 'done'
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
  AS BUILT (the design gate refused this spec's first draft — a late pin and
  a 10× overflow cap — and both lanes ratified the corrected mechanism; the
  review round then ratified this guarded-in-AuthStage formulation, recorded
  below). Three moved parts:

  **1. The post-input revalidation (A5).** In `runPipeline`, after
  `readRequestFields` resolves (the last awaited input step) and directly
  before `handler(context)` is invoked, re-run the handoff-fence check:
  `sessionRegistry.isSuperseded(context.session?.sessionKey)` → reject
  `unauthorized`. No await sits between the check and the mutating handlers,
  all of which commit synchronously. The re-validation re-runs the FENCE
  only — the ban check is not re-run (FR-15's recorded contract: in-flight
  requests are refused at next request). Gated on the actor class and the
  presence of an authz stage so partial-pipeline unit tests are unaffected;
  AuthzStage keeps its early slot.

  **2. Request-counted retention (A7) — the ratified mechanism.** The
  pipeline PINS each admitted request's session key. Placement ruling
  (recorded interpretation of the two gate rules, which read literally
  against each other — codex demanded the pin be one non-yielding operation
  with successful verification; agy forbade incrementing inside
  `AuthStage.process` to protect standalone stage tests): the pin is
  acquired INSIDE `AuthStage.process`, synchronously with successful
  verification, ONLY when `runPipeline` owns the request's pin lifecycle
  (`context.pipelinePinManaged`, set before the stage loop) — a standalone
  `new AuthStage().process()` never pins, so it never leaks; and
  `runPipeline`'s `finally` releases the pin exactly once on every exit
  path, then clears the flag. In the registry (`server/api/session.mjs`):
  `enterInFlight`/`leaveInFlight` keep per-key counts; a superseded key's
  fence entry is PINNED while its count is above zero and is NEVER evicted
  under any circumstance; the 1,000 bound gates only IDLE TOMBSTONES
  (zero-count entries, evicted oldest-first — on insert and on the
  leaveInFlight that frees one); there is NO hard cap on protected entries
  and no overflow error after a transfer (an overflow refusal placed after
  bindSession's durable write would itself be unsafe). Retention is
  proportional to genuinely outstanding displaced requests — "unexhaustible"
  is the guarantee about requests, not a claim of bounded memory independent
  of concurrency.

  **3. The prose states the repaired truth, placement-accurately.** The
  fence is asked at THREE placements: the authorization stage (as early as
  the stage sequence reaches — before the body for most routes; the send
  route's budget stage reads first), runPipeline's post-input revalidation,
  and the long-poll route's per-wake check (a displaced poll stops serving
  its holder on the next wake — work already inside a handler is not torn
  back out). Every comment, README paragraph, CHANGELOG entry and the Spine
  amendment say exactly this; the v0.2.0 CHANGELOG entry's honest "one
  limit" disclosure stands as that release's record.

  **4. The committed regressions.** The A5 gap row FLIPPED (refused, handler
  never called, nothing claimed); the send-route interleaving row (pin
  acquired with authentication, proved by spies, before the budget stage's
  body wait; churn cannot forget the pinned predecessor); the thirteen-exit
  exactly-once matrix (one enter/leave pair per shape, context bookkeeping
  cleared); the 1,002-protected-predecessors row (all fenced past the bound
  through revoke/re-supersede/re-issue; each release drains without a
  supersession following); the multi-request-per-key row (the fence holds
  until the LAST request ends); and the displaced-long-poll row (takeover
  ~1 s into a 10 s hold — a hundred-fold margin over admission — with the
  early 401 itself as the wake-check evidence).
acceptance_criteria: |
  | # | Given | When | Then |
  |---|---|---|---|
  | 1 | A request admitted before a same-Actor takeover, its body still arriving | the body completes after the handoff | the post-input revalidation refuses it (`unauthorized`) at the fence — the handler never runs (the executed gap, closed) |
  | 2 | The same request | the handoff lands after its revalidation | it completes (the check is a point-in-time truth, not a retroactive one) |
  | 3 | More supersessions than the old bound, each displaced session holding a live in-flight request | the fence is queried for every displaced key | every one is still fenced — retention is unexhaustible (1,002 keys proven on the default bound) |
  | 4 | More supersessions than the old bound, none in flight | the fence is queried | the oldest idle tombstones were evicted (the memory bound holds, safely) |
  | 5 | A long-poll that entered its hold before the takeover | its next wake | the fence check beside the ban check refuses the displaced poll |
  | 6 | The shipped source and docs | read | every placement-accurate statement of the repaired behavior — the two session.mjs comments, the pipeline block, the takeover prose in server.mjs and the CLI (help text included), the README, the CHANGELOG's Unreleased entry, the Spine amendment |
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
