# REL-3 soak results — Story 6.2 (v0.2.0 candidate)

**Status: ABORTED** — run 2026-10-22T02:41:02.213Z -> 2026-10-22T04:51:24.327Z (130.37 min wall).

## Verdict inputs

| Item | Value |
| --- | --- |
| Candidate identity | candidate-exact (candidate commit 3929cc74f30f1b0b1f5b989c6e9fbb9d4fed6eba) |
| Host / Node / SQLite | ngs-staging / v24.18.0 / 3.53.1 |
| Server child | pid 1325282, port 33393, version 0.2.0 |
| Clients (concurrent sessions) | 4 |
| Acknowledged messages | 7235 |
| Bursts / reconnects | 12 / 2 |
| Samples (RSS+FD) | 128 every 60000 ms |

## Rules

```json
{
  "finalWindowRss": {
    "windowMs": 14400000,
    "samples": 128,
    "expectedSamples": 240,
    "minimumSamples": 192,
    "pass": false,
    "incomplete": true,
    "note": "the final window holds 128 samples; the rule needs at least 192 of the expected 240 — the run is INCOMPLETE, never scored"
  },
  "fdStability": {
    "baselineAfterMs": 3600000,
    "baselineFd": 23,
    "samplesAfterBaseline": 68,
    "worstAbsDrift": 1,
    "corridor": 5,
    "rule": "every sample at or after duration/8 (one hour at the default 8) sits within +-5 of the hour-one baseline"
  },
  "zeroMessageLoss": {
    "pending": true,
    "note": "the run ended before the final drain"
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
      "at": "2026-10-22T02:41:02.723Z",
      "actors": 0,
      "rssBytes": 67358720,
      "fdCount": 22,
      "cpuSeconds": 0.2
    },
    {
      "at": "2026-10-22T03:41:14.215Z",
      "actors": 0,
      "rssBytes": 106082304,
      "fdCount": 22,
      "cpuSeconds": 11.84
    },
    {
      "at": "2026-10-22T03:41:22.481Z",
      "actors": 4,
      "rssBytes": 110399488,
      "fdCount": 22,
      "cpuSeconds": 13.02
    },
    {
      "at": "2026-10-22T04:41:14.212Z",
      "actors": 0,
      "rssBytes": 112611328,
      "fdCount": 22,
      "cpuSeconds": 20
    },
    {
      "at": "2026-10-22T04:41:22.532Z",
      "actors": 4,
      "rssBytes": 111169536,
      "fdCount": 22,
      "cpuSeconds": 20.96
    }
  ]
}
```

## Failures

- traffic loops did not settle within 60000 ms

Machine-readable record: beside this file, `v0.2.0-soak-results.json`.
