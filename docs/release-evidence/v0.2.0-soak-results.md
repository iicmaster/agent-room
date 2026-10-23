# REL-3 soak results — Story 6.2 (v0.2.0 candidate)

**Status: PASS** — run 2026-10-22T12:33:56.840Z -> 2026-10-23T00:38:33.246Z (724.61 min wall).

## Verdict inputs

| Item | Value |
| --- | --- |
| Candidate identity | candidate-exact (candidate commit 3929cc74f30f1b0b1f5b989c6e9fbb9d4fed6eba) |
| Host / Node / SQLite | ngs-staging / v24.18.0 / 3.53.1 |
| Server child | pid 2456290, port 45059, version 0.2.0 |
| Clients (concurrent sessions) | 4 |
| Acknowledged messages | 33725 |
| Bursts / reconnects | 71 / 11 |
| Samples (RSS+FD) | 721 every 60000 ms |

## Rules

```json
{
  "finalWindowRss": {
    "windowMs": 14400000,
    "samples": 240,
    "elapsedMs": 14340026,
    "startRssBytes": 122527744,
    "endRssBytes": 120250368,
    "growthRatio": -0.018586614962893627,
    "slopeBytesPerMs": 0.04778181104083644,
    "impliedGrowthRatio": 0.0055921409330174365,
    "slopePctOfStartPerSecond_reportedNotGated": 0.0000389967279907124,
    "bound": 0.02,
    "rule": "(endRSS - startRSS_of_window) / RSS_at_window_start <= 0.02, and the least-squares slope's implied growth across the window <= 0.02 — FR-13's single pass rule (the final four hours). The endpoint growth is reported, never gated: FR-13 ratifies one band, and the endpoint term was never ratified. Not the Story 2.4 per-second rate.",
    "pass": true,
    "gatedTerm": "slope_implied_growth",
    "reportedOnly": {
      "endpoint_growthRatio": -0.018586614962893627,
      "endpoint_bound": 0.02,
      "endpoint_pass": true,
      "note": "the endpoint term is reported, never gated: FR-13 ratifies one band (the slope), and this term was never ratified"
    }
  },
  "fdStability": {
    "baselineAfterMs": 3600000,
    "baselineFd": 23,
    "samplesAfterBaseline": 661,
    "worstAbsDrift": 1,
    "corridor": 5,
    "rule": "every sample at or after duration/8 (one hour at the default 8) sits within +-5 of the hour-one baseline",
    "pass": true
  },
  "zeroMessageLoss": {
    "ackedCount": 33725,
    "readableCount": 33725,
    "duplicates": 0,
    "lostOrPhantom": 0,
    "unreadAcknowledged": 0,
    "perRoom": {
      "u_9wbOJa0HZpJc3IXgUImw": 6745,
      "zC_f6Awd62Bl9ltxMg9TJg": 6745,
      "ZVCLXhnFriMwft0d5DMObQ": 6745,
      "qvNHUwPfut1r0_04GruHGQ": 6745,
      "Js3YyBBK10dDMGBPGGeshw": 6745
    },
    "payloadFailures": [],
    "pass": true,
    "rule": "every acknowledged (room, seq, client_message_id) readable at the end; sequences contiguous from 1; readable set == acknowledged set; zero duplicates; payloads byte-exact"
  }
}
```

## REL-4 idle footprint (recorded, not gated)

```json
{
  "reported": true,
  "gated": false,
  "note": "REL-4 counter-metric: server RSS/FD/CPU with 0 Actors (start, each reconnect window, end) and the post-resume settled sample with the run's 4 Actors — reported, not optimized.",
  "samples": [
    {
      "at": "2026-10-22T12:33:57.410Z",
      "actors": 0,
      "rssBytes": 67321856,
      "fdCount": 22,
      "cpuSeconds": 0.19
    },
    {
      "at": "2026-10-22T13:34:07.897Z",
      "actors": 0,
      "rssBytes": 103383040,
      "fdCount": 22,
      "cpuSeconds": 11.19
    },
    {
      "at": "2026-10-22T13:34:16.489Z",
      "actors": 4,
      "rssBytes": 107606016,
      "fdCount": 22,
      "cpuSeconds": 12.41
    },
    {
      "at": "2026-10-22T14:34:07.894Z",
      "actors": 0,
      "rssBytes": 109326336,
      "fdCount": 22,
      "cpuSeconds": 19.16
    },
    {
      "at": "2026-10-22T14:34:16.160Z",
      "actors": 4,
      "rssBytes": 109133824,
      "fdCount": 22,
      "cpuSeconds": 20.1
    },
    {
      "at": "2026-10-22T15:34:07.892Z",
      "actors": 0,
      "rssBytes": 113967104,
      "fdCount": 22,
      "cpuSeconds": 28.09
    },
    {
      "at": "2026-10-22T15:34:16.135Z",
      "actors": 4,
      "rssBytes": 109662208,
      "fdCount": 22,
      "cpuSeconds": 28.94
    },
    {
      "at": "2026-10-22T16:34:07.893Z",
      "actors": 0,
      "rssBytes": 119574528,
      "fdCount": 22,
      "cpuSeconds": 37.8
    },
    {
      "at": "2026-10-22T16:34:16.127Z",
      "actors": 4,
      "rssBytes": 115126272,
      "fdCount": 22,
      "cpuSeconds": 38.65
    },
    {
      "at": "2026-10-22T17:34:07.896Z",
      "actors": 0,
      "rssBytes": 125145088,
      "fdCount": 22,
      "cpuSeconds": 48.07
    },
    {
      "at": "2026-10-22T17:34:16.085Z",
      "actors": 4,
      "rssBytes": 125145088,
      "fdCount": 22,
      "cpuSeconds": 48.82
    },
    {
      "at": "2026-10-22T18:34:07.895Z",
      "actors": 0,
      "rssBytes": 120786944,
      "fdCount": 22,
      "cpuSeconds": 58.02
    },
    {
      "at": "2026-10-22T18:34:16.106Z",
      "actors": 4,
      "rssBytes": 120786944,
      "fdCount": 22,
      "cpuSeconds": 58.81
    },
    {
      "at": "2026-10-22T19:34:07.894Z",
      "actors": 0,
      "rssBytes": 123539456,
      "fdCount": 22,
      "cpuSeconds": 68.22
    },
    {
      "at": "2026-10-22T19:34:16.171Z",
      "actors": 4,
      "rssBytes": 123674624,
      "fdCount": 22,
      "cpuSeconds": 69
    },
    {
      "at": "2026-10-22T20:34:07.897Z",
      "actors": 0,
      "rssBytes": 124784640,
      "fdCount": 22,
      "cpuSeconds": 78.67
    },
    {
      "at": "2026-10-22T20:34:16.171Z",
      "actors": 4,
      "rssBytes": 124289024,
      "fdCount": 22,
      "cpuSeconds": 79.46
    },
    {
      "at": "2026-10-22T21:34:07.893Z",
      "actors": 0,
      "rssBytes": 125779968,
      "fdCount": 22,
      "cpuSeconds": 88.85
    },
    {
      "at": "2026-10-22T21:34:16.127Z",
      "actors": 4,
      "rssBytes": 125779968,
      "fdCount": 22,
      "cpuSeconds": 89.64
    },
    {
      "at": "2026-10-22T22:34:07.894Z",
      "actors": 0,
      "rssBytes": 126083072,
      "fdCount": 22,
      "cpuSeconds": 99.08
    },
    {
      "at": "2026-10-22T22:34:16.152Z",
      "actors": 4,
      "rssBytes": 125698048,
      "fdCount": 22,
      "cpuSeconds": 99.84
    },
    {
      "at": "2026-10-22T23:34:07.904Z",
      "actors": 0,
      "rssBytes": 120721408,
      "fdCount": 22,
      "cpuSeconds": 109.72
    },
    {
      "at": "2026-10-22T23:34:16.141Z",
      "actors": 4,
      "rssBytes": 120324096,
      "fdCount": 22,
      "cpuSeconds": 110.53
    },
    {
      "at": "2026-10-23T00:38:33.235Z",
      "actors": 0,
      "rssBytes": 195092480,
      "fdCount": 22,
      "cpuSeconds": 128.82
    }
  ]
}
```

No failures recorded.

Machine-readable record: beside this file, `v0.2.0-soak-results.json`.
