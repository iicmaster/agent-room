# Diagnostic — what the hourly reconnect's 1,008 token mints actually cost

**Date:** 2026-10-21 · **Host:** NSG-Mac-mini.local (the attempt-2 host) · **Artifact:** the
materialized v0.2.0 candidate (`89c8477`), server child only, no traffic

This is the mechanism probe the advisor's round-table asked for (Winston's Option D,
first half). It is **diagnostic, not release evidence**: it runs the shipped server
outside any soak, on a different host from attempt 3, and it changes no gate and no
candidate.

## What was measured

The soak's hourly reconnect mints `SESSIONS_MAX + 2*CLIENT_COUNT` = **1,008** session
tokens to arm the server's eviction path (each is a local-auth exchange that issues a
session token). The question: does that mint burst leave memory behind?

**Arm A — 1,008 local-auth exchanges (each ISSUES a session token):**

| Cycle | RSS before | RSS after | Delta |
|---|---|---|---|
| 1 | 62.6 MiB | 84.9 MiB | **+22.3 MiB** |
| 2 | 84.9 MiB | 90.5 MiB | +5.7 MiB |
| 3 | 92.1 MiB | 92.2 MiB | +0.0 MiB |

**Arm B — 1,008 `GET /health` (same HTTP work, NO session issued):** +1.6 MiB.

**Arm C — a second 1,008-mint cycle after B:** +0.0 MiB.

**Reclamation:** after the mint burst and 30 s of idle, RSS fell **83.6 MiB → 67.5 MiB**
and stayed there (60 s idle: 67.5 MiB).

## What this establishes

- The +22 MiB is **transient V8 young/old-space garbage, not retained memory**: it is
  returned to the operating system when the process is idle, and a second identical
  burst adds nothing (+0.0 MiB).
- The growth is **attributable to the auth exchange path** (arm A) rather than to the
  HTTP request path (arm B) — but it is bounded and reclaimable, so the session
  registry is not the retainer.
- `server/api/session.mjs` keeps `sessions.size` bounded at `SESSIONS_MAX = 1000`; the
  redundant `[...sessions.entries()].find(...)` in the capacity path allocates ~40 KB of
  short-lived tuples per mint at capacity, which is consistent with the observed
  transient spike, and is a **cleanup for v0.2.1, not a v0.2.0 fix** — changing
  `server/` would void candidate `89c8477` for a non-defect.

## What this does NOT establish

- It does not explain attempt 2's **sustained** rise (hourly medians 30.3 → 79.1 MiB
  across hours 5–8, with every one of the sixty matched-phase differences positive,
  mean +45.15 MiB). A reclaimable transient cannot produce a monotone, phase-matched
  rise; that rise is the thing attempt 3 on a quiet host must explain.
- It was measured on the attempt-2 host, under the same load conditions that
  compressed attempt 2's baseline, so it cannot rule host pressure in or out.
- It did not capture V8 heap counters or GC events — the tracker samples OS RSS only.

**Reproduction:** the probe is a small standalone script (spawn the materialized
server, mint, sample `ps -o rss=`); it is not part of the repository, because shipping
it would mean shipping a file the release gate does not own.
