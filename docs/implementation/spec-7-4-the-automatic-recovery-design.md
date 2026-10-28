---
title: 'The automatic recovery design — A2 round-table: RECORDED REFUSAL'
type: 'design'
created: '2026-10-28'
status: 'done — the refusal is the deliverable'
baseline_revision: 'working-tree on 45d1aa8 (the round-table ran against this tree; the release-truth fix below rode with the record)'
context:
  - '{project-root}/docs/epics.md (Story 7.4)'
  - '{project-root}/docs/implementation/reviews/epic-7-a2-recovery-design-codex.md (the round-table verdict, verbatim)'
  - '{project-root}/docs/implementation/reviews/epic-7-a2-recovery-design-brief.md (the dispatched brief)'
problem: |
  Whether an automatic unattended crash-recovery design exists that survives
  the Two-Tab Co-Tenancy Test, or the reasoned refusal is the answer.
outcome: |
  **RECORDED REFUSAL** (the AC's default baseline, delivered): all four named
  candidates FAIL — the disk-only secret by construction (two live tabs share
  `${PLUGIN_DATA}`); the kernel-socket probe on its own evidence (Apple XNU
  can return ECONNREFUSED to a LIVE listener whose accept queue is full or
  whose allocation failed — "ECONNREFUSED is the OS's death certificate" is
  REFUTED from primary sources, and the shared-pathname stale-unlink race has
  a worked counterexample; immutable per-generation paths would fix the race
  but not the macOS ambiguity, and the remote server still witnesses nothing);
  the lease/heartbeat (prior refusal confirmed — silence is policy, not
  death); and self-reported lineage (server cannot verify remote processes).
  Consent: per-event explicit decision stays the supported contract for this
  release; narrow prior delegation to a named supervisor is RECORDED as a
  possible NEW policy (Sally's standing dissent — ratifiable only with a
  supervisor that demonstrably keeps the Two-Tab exclusion, and a five-part
  honest-consent shape now written into the record). No server surface
  changes. The ping-pong answer: supported reconnect never carries intent, so
  no automatic war can start from supported clients; last-explicit-intent-
  wins remains the human-level rule until Story 7.2.
provenance: |
  ONE VENDOR, RECORDED: the codex lane (`gpt-6.1-sol[ultra] (matched)`) is
  the sole voice of record — the agy seat returned RESOURCE_EXHAUSTED (429,
  resets ~2026-11-01) on every attempt, and the claude substitute lane cannot
  authenticate (QWEN_API_KEY absent). Per the recorded playbook the
  substitution is disclosed, not smoothed: this verdict is one vendor's
  round-table, strengthened by its own primary-source work (Apple XNU,
  Node 24 docs). A second vendor may be run later against the archived brief;
  the refusal's substance is mechanical enough that a disagreement would be
  about product appetite (Sally's), not the evidence.
hygiene-rider: |
  Vex's source finding in Story 7.3's release path — the coordinated
  rollback's boolean was awaited but not read, so a FAILED rollback still
  reported released:true — is fixed in this change set (the boolean is now
  the released value; the gated A9 row stays green). No story is reopened.
unblock-record: |
  The earlier block (the ~/.npm readdir wedge) cleared by itself: the
  directory emptied (its contents now live at ~/.kingston-cache/npm — the
  cache root moved), after which the pinned codex adapter reinstalled with
  matching digests and the lane dispatched cleanly. The full outage
  diagnosis and the gh-account switch note are recorded in the session
  memory, not here.
