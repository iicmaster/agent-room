# REL-3 soak results — Story 6.2 (v0.2.0 candidate)

**Status: FAIL** — run 2026-10-20T19:52:23.300Z -> 2026-10-21T03:53:53.861Z (481.51 min wall).

## Verdict inputs

| Item | Value |
| --- | --- |
| Candidate identity | candidate-exact (candidate commit 89c847787357be9e0ede135337eee4a1a29f48bf) |
| Host / Node / SQLite | NSG-Mac-mini.local / v24.18.1 / 3.53.4 |
| Server child | pid 41533, port 51401, version 0.2.0 |
| Clients (concurrent sessions) | 4 |
| Acknowledged messages | 22615 |
| Bursts / reconnects | 47 / 7 |
| Samples (RSS+FD) | 481 every 60000 ms |

## Rules

```json
{
  "finalWindowRss": {
    "windowMs": 14400000,
    "samples": 240,
    "elapsedMs": 14340352,
    "startRssBytes": 31981568,
    "endRssBytes": 86360064,
    "growthRatio": 1.7003073770491803,
    "slopeBytesPerMs": 4.7683193395442816,
    "impliedGrowthRatio": 2.1380870937119942,
    "slopePctOfStartPerSecond_reportedNotGated": 0.014909585857529817,
    "bound": 0.02,
    "rule": "(endRSS - startRSS_of_window) / RSS_at_window_start <= 0.02, and the least-squares slope's implied growth across the window <= 0.02 — a total-growth bound (the final four hours at the default 8-hour duration), not the Story 2.4 per-second rate",
    "pass": false
  },
  "fdStability": {
    "baselineAfterMs": 3600000,
    "baselineFd": 20,
    "samplesAfterBaseline": 421,
    "worstAbsDrift": 2,
    "corridor": 5,
    "rule": "every sample at or after duration/8 (one hour at the default 8) sits within +-5 of the hour-one baseline",
    "pass": true
  },
  "zeroMessageLoss": {
    "ackedCount": 22615,
    "readableCount": 22615,
    "duplicates": 0,
    "lostOrPhantom": 0,
    "unreadAcknowledged": 0,
    "perRoom": {
      "go-w6K76XgRosqqjP4Ge2g": 4523,
      "VgmirJI4kSi2Ol6YjDMtpw": 4523,
      "BtP-AW-j44F0OPA2Y9LgwQ": 4523,
      "TPqvyurpryV2ABseRCRJaA": 4523,
      "CSfJqXsP71DKCstVeWBCvw": 4523
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
      "at": "2026-10-20T19:52:23.868Z",
      "actors": 0,
      "rssBytes": 65683456,
      "fdCount": 18,
      "cpuSeconds": 0.16
    },
    {
      "at": "2026-10-20T20:52:31.387Z",
      "actors": 0,
      "rssBytes": 40648704,
      "fdCount": 18,
      "cpuSeconds": 9.62
    },
    {
      "at": "2026-10-20T20:52:39.048Z",
      "actors": 4,
      "rssBytes": 55476224,
      "fdCount": 18,
      "cpuSeconds": 10.05
    },
    {
      "at": "2026-10-20T21:52:31.380Z",
      "actors": 0,
      "rssBytes": 40189952,
      "fdCount": 18,
      "cpuSeconds": 16.55
    },
    {
      "at": "2026-10-20T21:52:39.024Z",
      "actors": 4,
      "rssBytes": 61276160,
      "fdCount": 18,
      "cpuSeconds": 17
    },
    {
      "at": "2026-10-20T22:52:31.381Z",
      "actors": 0,
      "rssBytes": 40058880,
      "fdCount": 18,
      "cpuSeconds": 24.07
    },
    {
      "at": "2026-10-20T22:52:39.019Z",
      "actors": 4,
      "rssBytes": 44400640,
      "fdCount": 18,
      "cpuSeconds": 24.39
    },
    {
      "at": "2026-10-20T23:52:31.399Z",
      "actors": 0,
      "rssBytes": 31637504,
      "fdCount": 18,
      "cpuSeconds": 32.62
    },
    {
      "at": "2026-10-20T23:52:39.416Z",
      "actors": 4,
      "rssBytes": 31801344,
      "fdCount": 18,
      "cpuSeconds": 33.02
    },
    {
      "at": "2026-10-21T00:52:31.378Z",
      "actors": 0,
      "rssBytes": 26247168,
      "fdCount": 18,
      "cpuSeconds": 41.95
    },
    {
      "at": "2026-10-21T00:52:39.363Z",
      "actors": 4,
      "rssBytes": 39288832,
      "fdCount": 18,
      "cpuSeconds": 42.36
    },
    {
      "at": "2026-10-21T01:52:31.383Z",
      "actors": 0,
      "rssBytes": 26247168,
      "fdCount": 18,
      "cpuSeconds": 50.71
    },
    {
      "at": "2026-10-21T01:52:39.076Z",
      "actors": 4,
      "rssBytes": 26492928,
      "fdCount": 18,
      "cpuSeconds": 51.04
    },
    {
      "at": "2026-10-21T02:52:31.373Z",
      "actors": 0,
      "rssBytes": 85393408,
      "fdCount": 18,
      "cpuSeconds": 61.08
    },
    {
      "at": "2026-10-21T02:52:38.878Z",
      "actors": 4,
      "rssBytes": 87326720,
      "fdCount": 18,
      "cpuSeconds": 61.34
    },
    {
      "at": "2026-10-21T03:53:53.832Z",
      "actors": 0,
      "rssBytes": 170164224,
      "fdCount": 18,
      "cpuSeconds": 73.25
    }
  ]
}
```

## Failures

- final-window RSS growth above the 2% total-growth bound

Machine-readable record: beside this file, `v0.2.0-soak-results.json`.
