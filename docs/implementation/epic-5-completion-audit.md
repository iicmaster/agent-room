# Epic 5 Completion Audit — Watch from Outside

Date: 2026-09-29 · Commit range `5b63382` (post-Epic-4) → `be30d74` · Suite: **544 pass / 0 fail / 0 skipped** · AC sweep: **clean** (3 stories, 5 criteria, 21 evidence pointers)

## Verdict

**Epic 5 is complete.** The viewer is live (one SSE stream carrying room + presence), safe by
construction (HttpOnly SameSite=Strict cookie, no credentials in URLs, DMs excluded by
construction, inert rendering under CSP), and its exposure beyond loopback is proven: unauthenticated
requests are refused with zero previews, the surface is GET-only, and the viewer token never
authorizes any write anywhere.

## Story ledger

| Story | Commit | Proof |
|---|---|---|
| 5.1 viewer auth bridge | `173f66a` | `tests/viewer.test.mjs` (12) — cookie flags, class isolation both directions, rotation visible at next request, query-string credentials structurally impossible |
| 5.2 live room & presence view | `173f66a` | one SSE stream (message + presence frames, Last-Event-ID resume), all eight lifecycle states trigger-and-assert, committed message rendered within the bound, inert rendering under CSP, DM exclusion by construction |
| 5.3 remote exposure check | `be30d74` | `tests/viewer-exposure.test.mjs` (3) — 12 unauthenticated shapes refused with zero previews over the real non-loopback TLS topology, 20 GET-only rows, the token never authorizes a write (state proof: nothing written anywhere), positive control over the same interface |

## What the reviews found

- The exposure check's own review pass confirmed the strongest claims held: the loopback door
  refusing on the same port is what makes the non-loopback proof genuine; the refusal bodies
  carry zero previews (10-marker scan); the operator writes (trust/invite/ban) have no HTTP
  surface at all (AR-13) — phantom paths 404 even with the token presented.
- All findings from the 5.1/5.2 build were folded pre-commit (route-pin rewrites for the newly
  live routes, the presence probe path's invariant preserved).

## Known limits at Epic 5 close

- The exposure drill is one machine (non-loopback interface + real TLS) — physical cross-machine
  wire remains Epic 6's REL-1, consistent with Story 4.8's scoping.
- The viewer reads ONLY the Broadcast Room; DMs are excluded by construction, not by policy
  configuration.
- The cookie is a session cookie (no invented lifetime constant) — rotation invalidates at next
  request; whether a persistent cookie lifetime is wanted is a product question for real use.
