# REL-3 soak results — Story 6.2 (v0.2.0 candidate)

**Status: FAIL** — run 2026-10-21T13:16:41.948Z -> 2026-10-21T21:19:21.437Z (482.66 min wall).

## Verdict inputs

| Item | Value |
| --- | --- |
| Candidate identity | candidate-exact (candidate commit 3929cc74f30f1b0b1f5b989c6e9fbb9d4fed6eba) |
| Host / Node / SQLite | ngs-staging / v24.18.0 / 3.53.1 |
| Server child | pid 1059106, port 37439, version 0.2.0 |
| Clients (concurrent sessions) | 4 |
| Acknowledged messages | 23080 |
| Bursts / reconnects | 47 / 7 |
| Samples (RSS+FD) | 481 every 60000 ms |

## Rules

```json
{
  "finalWindowRss": {
    "windowMs": 14400000,
    "samples": 240,
    "elapsedMs": 14340031,
    "startRssBytes": 119480320,
    "endRssBytes": 122155008,
    "growthRatio": 0.02238601302708262,
    "slopeBytesPerMs": 0.332280173377514,
    "impliedGrowthRatio": 0.039880274734106214,
    "slopePctOfStartPerSecond_reportedNotGated": 0.00027810452246655677,
    "bound": 0.02,
    "rule": "(endRSS - startRSS_of_window) / RSS_at_window_start <= 0.02, and the least-squares slope's implied growth across the window <= 0.02 — a total-growth bound (the final four hours at the default 8-hour duration), not the Story 2.4 per-second rate",
    "pass": false
  },
  "fdStability": {
    "baselineAfterMs": 3600000,
    "baselineFd": 23,
    "samplesAfterBaseline": 421,
    "worstAbsDrift": 1,
    "corridor": 5,
    "rule": "every sample at or after duration/8 (one hour at the default 8) sits within +-5 of the hour-one baseline",
    "pass": true
  },
  "zeroMessageLoss": {
    "ackedCount": 23080,
    "readableCount": 23080,
    "duplicates": 0,
    "lostOrPhantom": 0,
    "unreadAcknowledged": 0,
    "perRoom": {
      "TF5iEbHsFgYCwpXW0p5n5w": 4616,
      "1Qz1RIyXtMrsc4aihDvBVg": 4616,
      "y2MJoW_aqtsAJ01l3EHRMQ": 4616,
      "4DX4b03Ih5-PzWke37ssew": 4616,
      "_gNuGU8zUk-mEb5T6y0TVw": 4616
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
      "at": "2026-10-21T13:16:42.436Z",
      "actors": 0,
      "rssBytes": 67964928,
      "fdCount": 22,
      "cpuSeconds": 0.14
    },
    {
      "at": "2026-10-21T14:16:56.420Z",
      "actors": 0,
      "rssBytes": 99803136,
      "fdCount": 22,
      "cpuSeconds": 12.17
    },
    {
      "at": "2026-10-21T14:17:04.748Z",
      "actors": 4,
      "rssBytes": 105353216,
      "fdCount": 22,
      "cpuSeconds": 13.38
    },
    {
      "at": "2026-10-21T15:16:56.419Z",
      "actors": 0,
      "rssBytes": 107241472,
      "fdCount": 22,
      "cpuSeconds": 20.36
    },
    {
      "at": "2026-10-21T15:17:04.769Z",
      "actors": 4,
      "rssBytes": 106508288,
      "fdCount": 22,
      "cpuSeconds": 21.28
    },
    {
      "at": "2026-10-21T16:16:56.423Z",
      "actors": 0,
      "rssBytes": 110190592,
      "fdCount": 22,
      "cpuSeconds": 29.44
    },
    {
      "at": "2026-10-21T16:17:04.705Z",
      "actors": 4,
      "rssBytes": 107368448,
      "fdCount": 22,
      "cpuSeconds": 30.28
    },
    {
      "at": "2026-10-21T17:16:56.422Z",
      "actors": 0,
      "rssBytes": 115695616,
      "fdCount": 22,
      "cpuSeconds": 39.61
    },
    {
      "at": "2026-10-21T17:17:04.817Z",
      "actors": 4,
      "rssBytes": 113680384,
      "fdCount": 22,
      "cpuSeconds": 40.46
    },
    {
      "at": "2026-10-21T18:16:56.422Z",
      "actors": 0,
      "rssBytes": 118468608,
      "fdCount": 22,
      "cpuSeconds": 50.06
    },
    {
      "at": "2026-10-21T18:17:04.675Z",
      "actors": 4,
      "rssBytes": 118075392,
      "fdCount": 22,
      "cpuSeconds": 50.84
    },
    {
      "at": "2026-10-21T19:16:56.422Z",
      "actors": 0,
      "rssBytes": 123551744,
      "fdCount": 22,
      "cpuSeconds": 60.61
    },
    {
      "at": "2026-10-21T19:17:04.684Z",
      "actors": 4,
      "rssBytes": 117129216,
      "fdCount": 22,
      "cpuSeconds": 61.41
    },
    {
      "at": "2026-10-21T20:16:56.421Z",
      "actors": 0,
      "rssBytes": 117985280,
      "fdCount": 22,
      "cpuSeconds": 70.46
    },
    {
      "at": "2026-10-21T20:17:04.653Z",
      "actors": 4,
      "rssBytes": 117989376,
      "fdCount": 22,
      "cpuSeconds": 71.22
    },
    {
      "at": "2026-10-21T21:19:21.436Z",
      "actors": 0,
      "rssBytes": 210964480,
      "fdCount": 22,
      "cpuSeconds": 84.53
    }
  ]
}
```

## Failures

- final-window RSS growth above the 2% total-growth bound

Machine-readable record: beside this file, `v0.2.0-soak-results.json`.
