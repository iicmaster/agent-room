# Epic 6 Release-Gate Resolution — the final release act of v0.2.0 (2026-10-25)

Two advisor lanes ran the release-gate review over the six-step release plan and
the repository at `53777cb`, both as bmad-party-mode round-tables, both READ-ONLY
with verified identities:

- codex lane — `gpt-6.1-sol[ultra] (matched)`: **3–1 split** (John APPROVE; Sally,
  Winston, Morgan REFUSE the plan as written). Archived verbatim beside this file:
  `epic-6-release-gate-2026-10-25-codex.md`.
- agy lane — `gemini-4-argon-high (matched)`: **APPROVE 4–1** (Winston, John, Vex,
  Sally APPROVE; Grumbal a narrowed conditional dissent on the release body and the
  live demo host, "CONCUR ON TAGGING `53777cb` AND SHIPPING THE `3929cc7` BYTES").
  Archived verbatim beside this file: `epic-6-release-gate-2026-10-25-agy.md`.

## Where the two vendors agree (cross-vendor facts, each independently verified)

1. The identity chain holds: packaged inputs have an empty diff `3929cc7..HEAD`;
   both lanes reproduced both frozen tree digests byte-for-byte
   (portable `3d90129b…`, claude_code `e481c9a4…`, 46 files each).
2. Tagging the docs-ahead closing commit breaks no gating consumer; the only
   noticing check is `rel1-preflight.mjs --role server`'s non-gating `[WARN] PV`.
3. No operational secret in the tracked tree or any of the 171 commits (codex
   scanned 855 blobs / 35.8 MB; agy scanned 336 tracked files + full history);
   only test PKI fixtures; `.vendor-lab/` never entered git.
4. The release notes omit TWO of the five v0.3 runtime items — **A7** (the
   `superseded` fence is bounded at 1,000 entries, so 1,001 supersessions can
   forget a still-admitted predecessor) and **A9** (a shutdown during the initial
   bind can assign a token after the shutdown release ran) — and omit attempt 6's
   non-gated `retainedState: rising` (0.65%/hour) finding. The publication body
   must carry them.
5. Materialize and hash BEFORE pushing (a digest failure must still be able to
   stop the act with nothing public); archive with `COPYFILE_DISABLE=1`; state
   tree digests and archive checksums as separate facts.
6. The live REL-1 demo container on ngs-2 (`43.229.78.103:18444`) must be stopped
   before its address and logs are published to a public repo.

## The one cross-vendor disagreement, and its resolution

codex's majority (Sally, Winston, Morgan) found **two surviving "authority"
comments in packaged source** whose claims the repo's own executed findings
refute — the same class of shipped-text defect that forced the third re-cut —
and refused a plan that shipped them without either fixing them (which under the
Candidate Immutability Law costs a full re-qualification) or recording an
explicit new acceptance. agy's majority rules the frozen bytes ship as-is and
that editing `server/` before tagging would violate the Candidate Immutability
Law and the ratified scope decisions. I verified codex's finding against the
source myself, and it is exact:

- `server/api/session.mjs` (the fenced-set comment) says a fence evicted at the
  bound "can no longer describe a request still in flight" — a claim a
  COUNT-based bound cannot make; A7's executed finding says 1,001 supersessions
  can forget a still-admitted predecessor.
- `server/api/session.mjs` (`isSuperseded`) says the authorization stage asks
  the fence "immediately before the handler runs" — but the stage sequence runs
  the fence check BEFORE a body-carrying route's body is read (A5's executed
  finding; `server/api/pipeline.mjs`).

### The decision (recorded, not implied)

**The two surviving comments above are accepted FOR v0.2.0 as shipped bytes, as
a NEW and EXPLICIT threshold decision made on 2026-10-25 under the operator's
delegated release instruction ("release it successfully; do not ask again; when
stuck, consult the advisors; have the advisors review before release"). This
decision claims NO prior approval and supersedes the comments-vs-recut handling
FOR THESE TWO OCCURRENCES ONLY.** Their correction is assigned to v0.3 beside
A5 (whose fix rewrites the fence-check placement and, with it, these comments)
and A7; the erratum below states, in the publication text, what the code
actually does, so no reader of the release relies on the comments' claims.

The alternative — fixing the comments and re-cutting through a fresh
12-hour soak and a fresh REL-1 — was weighed and declined as the costlier path
to the same disclosure, one that would contradict agy's immutability ruling and
re-open a ratified pre-registration without changing any behavior. The
disagreement is recorded, not blended: codex John reached this same ship-with-
erratum position; codex Sally, Winston and Morgan accepted it as viable exactly
under the conditions recorded here; agy approved the bytes unconditionally and
its conditions (A7/A9/retainedState in the release body, container teardown)
are met by this record and the publication text.

## The erratum (publication text, zero packaged bytes touched)

1. **REL-1 viewer freshness, authoritative figures.** The measured figures of
   record are `freshness.json`'s: **0.150 s** same-machine (seq 3, no clock
   term) and **0.276 s** cross-machine (seq 4; raw 0.172 s plus the measured
   clock offset 104 ms, with ±~0.9 s Date-header quantization uncertainty) —
   both far inside the 5 s bound; the canaries are seq 3 and seq 4, and the
   viewer rendered FOUR distinct broadcast texts. (Correction, from the
   confirmation round: `viewer-state.json`'s `messages[]` and `arrivals[]`
   record the SAME four messages, and `viewer-session.md` states all four
   arrived as live SSE — the earlier "each appearing twice: catch-up page and
   live arrival" reading here was wrong.)
   **Superseded:** the passage in `docs/release-evidence/v0.2.0-rel1/VERIFICATION.md`
   that narrates "eight broadcasts, canaries seq 7/8, 0.107 s / 0.217 s", and
   the completion-audit narrative's "0.217 s" parenthetical (the audit's own
   6.1 evidence row and the state record carry the correct 0.150/0.276). The
   evidence files themselves are never edited.
2. **The two packaged comments** (facts above): the shipped source's
   session-fence comments overstate the guarantee; the accurate statements are
   A5 and A7 as disclosed in the release notes and the audit. v0.3 corrects
   the comments with the A5 fix.
3. **Attempt 6's retained-state diagnostic** is RISING at ~0.65%/hour
   (post-GC used heap 9.2 → 9.3 MiB over 46 natural major collections in the
   final window): reported per the ratified amendment, never gated, carried to
   v0.3, and no "leak-free" claim is made.

## The revised release sequence (both vendors' sequencing conditions applied)

1. Commit this record and the release-notes supplements (docs only).
2. Stop the REL-1 demo container on ngs-2 and confirm `:18443`/`:18444` no
   longer answer.
3. Tag `v0.2.0` (annotated) at the closing commit; materialize from a TAGGED
   WORKTREE with one `package-release.mjs --out` invocation (both packages are
   subdirectories of one parent); require both tree digests EQUAL to the frozen
   record before anything is public; archive with `COPYFILE_DISABLE=1`.
4. One confirmation round to the codex lane on this revised plan.
5. Push main + tag; publish the GitHub release with the corrected body (status
   banner, complete A5–A9 disclosure, retainedState, this erratum, both digest
   kinds) and the two archives as assets.
