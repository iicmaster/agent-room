---
title: 'The automatic recovery design — A2 round-table (BLOCKED on the advisor-lane infrastructure)'
type: 'design'
created: '2026-10-28'
status: 'blocked-on-the-advisor-lane-infrastructure'
baseline_revision: 'working-tree on 68e4573 (Story 7.3 closed; this story needs its two-vendor round-table before anything else moves)'
context:
  - '{project-root}/docs/epics.md (Story 7.4 — pre-commits to nothing; the Two-Tab Co-Tenancy Test is the falsification bar)'
  - '{project-root}/docs/implementation/reviews/epic-7-a2-recovery-design-brief.md (the dispatched brief, verbatim)'
  - '{project-root}/docs/implementation/reviews/epic-7-design-gate-{codex,agy}.md (the named candidates and their known failure modes)'
  - '{project-root}/docs/implementation/reviews/epic-6-lease-astra.md (the v0.2 ruling that refused leases/heartbeats)'
problem: |
  The story IS a two-vendor design round-table; the round-table instrument is
  down. Every dispatch attempt on 2026-10-28 failed on INFRASTRUCTURE, not on
  the question:

  - **agy** (`gemini-4-argon-high`, identity verified at dispatch): the first
    run went `awaiting_agent → suspected_stalled → process gone` with no
    terminal state and no outbox (a hard kill / OOM shape); the immediate
    re-dispatch stalled the same way and was stopped.
  - **codex** (`gpt-6.1-sol[ultra]`): two dispatches hung with ZERO liveness
    and an empty runner log — the lane never reached identity
    acknowledgement. Root cause localized: the companion's adapter resolution
    runs a recursive scan over `~/.npm/_npx`, and `~/.npm` itself now HANGS
    on `readdir` (os.listdir with an 8-second alarm times out; `stat` on the
    directory answers instantly; `~/.bun` reads in 3 ms). A filesystem-level
    wedge on that one directory tree blocks every scan that touches it —
    this also explains why the plugin's own handshake probes time out.
  - **claude** (the recorded substitute voice): dispatched per the lane-ops
    playbook, but the `claude-qwen` wrapper derives its credential from
    `QWEN_API_KEY`, which is absent from this session's environment (the
    qwen profile's settings.json carries no key), so the lane cannot
    authenticate. It was stopped and cleaned up.

  All five dispatch attempts were cleaned up (dispatch-pids and liveness
  files removed; no half-written state). The brief is archived verbatim so
  the round-table can be re-run the moment the instrument returns.
what-was-verified-anyway: |
  - The story's framing survives its own design gate: the brief embeds the
    amended AC (pre-commit to nothing; reasoned refusal is the default
    baseline; Two-Tab Co-Tenancy as the falsification bar), the four named
    candidates with their recorded failure modes, the consent/trust/surface/
    ping-pong questions, and the Story 7.3 delta (the residual squat
    scenarios shrank to SIGKILL / OOM / power loss / dead peer).
  - No design, decision, or preference was recorded in the lanes' absence —
    synthesizing the round-table's answer myself would be attestation, the
    one thing this project does not accept.
unblock: |
  Any ONE of these returns the story to executable:

  1. The `~/.npm` directory wedge clears (typically: close the processes
     holding vnodes there, or reboot; `ls ~/.npm` answering instantly is the
     test) — then re-run the codex lane with the archived brief.
  2. A working agy seat (re-dispatch; the hard death may have been the same
     disk storm or the seat's own outage).
  3. `QWEN_API_KEY` exported for the claude substitute lane (the wrapper at
     /Users/ngs/bin/claude-qwen reads it from the environment).

  Then: dispatch BOTH voices on the archived brief, archive both outboxes
  verbatim, write the design-or-refusal record, and only then does 7.2's
  wire work start (the design gate's ordering rule).
