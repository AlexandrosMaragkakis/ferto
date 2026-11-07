# Refresh engine: costs, coverage and observations

## Reusable identity and fresh availability

The full-track cache lasts one day. `recording_identity_cache` retains the
stable recording metadata needed for ISRC selection for 30 days, without
playability, restriction or relinking flags. Discovery pages also last 30 days.
Neither cache extends its lifetime when read.

Album-track pages supply fresh market availability for up to 50 tracks in one
request. Their availability snapshot lasts one day. An expired snapshot causes
the album page to be fetched even if the discovery ids remain cached. Identity
and availability are combined only when their returned Spotify ids agree.
Missing `is_playable`, corrupt entries, changed relinks and expired identity
fall back to full track lookups. Restrictions fail closed. Account and market
isolation, canonical Never identities and current known exclusions still apply.
The source fields are documented by [Spotify](https://developer.spotify.com/documentation/web-api/reference/get-an-albums-tracks).

The simulator's 40-artist weekly workload uses 650 HTTP attempts cold and 125
on each of the next two weekly refreshes, including fresh album availability.
That is roughly 81% fewer requests than the cold run. A six-week fixture also
verifies that identity expires after 30 days: lookups resume in week six, and
cache hits have not postponed the deadline. Another fixture changes a playable
song to unavailable, makes a previously unavailable song playable, and changes
a relink; the next refresh publishes the exact independently expected set and
uses one full lookup for the changed relink.

Compared with the previous eight-day full-response policy on the same
40-artist fixture, four weekly runs use `[650, 55, 640, 55]` requests under that
policy and `[650, 125, 125, 125]` with the split cache. After the common cold
run, the three follow-ups total 750 versus 375 requests: 50% fewer overall.
The first warm follow-up costs more because availability is refreshed daily;
later follow-ups avoid the alternating full-metadata recrawl. The baseline was
reconstructed in an isolated checkout of the committed simulator with the
previous eight-day positive/day-long uncertain-response cache policy, using
the same fixture, seed and weekly spacing. No live API calls were involved.

These are synthetic fixture measurements, not Spotify quota estimates. Newly
deployed caches need warming. Metadata corrections can wait up to 30 days for
identity expiry; availability changes wait until the next refresh after the
daily availability snapshot expires. The app does not continuously poll every
song for real-time availability.

## Fair artist turns and early results

Each artist has a persistent turn count and its own pagination cursor. The
dispatcher admits up to eight active artists, prioritising artists absent
from the live shelf and discovery already started, then chooses the least-served
artist within that group. After quota waits, queued song/release work takes
precedence over retrying a cold release list or admitting untouched artists.
Completed artists free a place for the next artist. This avoids spending an
entire quota window reading thousands of release lists before processing any
of their songs. A turn handles one
release/discovery page or five HTTP metadata misses while artists compete.
Cache hits may fill the existing 30-track batch without consuming the HTTP
turn budget. The final remaining artist can use that full bounded batch.
Partial successes checkpoint normally before waiting; leases, retry deadlines,
revision guards and independent known/Never filtering still apply.

An asymmetric fixture gives the first of six artists 20 extra albums, with a
synthetic metadata quota of 20 calls/day. Serial scheduling reaches only one
artist's staged results before the first quota interruption; fair turns reach
four. Both runs publish the same 105 expected recordings. Fairness redistributes
when results arrive; it cannot increase the provider's total quota. More turns
can require additional SQL and Queue deliveries. Compare local statement/write
measurements separately from actual production D1 row metrics.

First-install publication exposes eligible results after the initial known-track
scans, before all artists finish. Subsequent refreshes append new eligible
recordings with each validated song batch, preserving existing cards and their
representatives. Staging, the copy, dense slots, counts and publication ledger
commit in one revision-guarded D1 batch. Artists can remain unfinished and keep
their release cursors. Both generations' known
filters and permanent Never decisions apply. Replayed deliveries cannot append
or count a recording twice. Failed publication batches roll back together.
Later liked scans and learned canonical aliases copy exclusions into the live
publication overlay too, so they remain authoritative after quarantine.

During a provider wait, a delivery can publish up to 30 already validated
staged recordings for one artist using database work only. It never refreshes
a token, calls Spotify, advances source cursors, increments the job revision or
clears retry/pacing gates. A fresh immediate delivery continues publication;
when no additions remain, normal delayed dispatch resumes. Explicit owner wakes
can start that publication path while the status still reports the original
wait. Publication remains disabled before initial exclusions are frozen.
Its separate publication cursor seeks by artist and recording key, avoiding
repeated scans of already published artists during an upgraded staging backlog.
Warm batches whose keys are already public skip publication writes.

Migration `0021_progressive_artist_publication.sql` preserves active work and
retry gates. Its ledger distinguishes additions from the original live shelf,
so early publication cannot inflate final overlap or hide discovery yield.
The final replacement remains atomic and retains its empty/quarantine gates.
Failure or quarantine leaves the existing shelf and already published additions
available. Owner progress reports newly available recordings and artist buckets,
with a last-publication timestamp. Ledger rows follow the 30-run history limit.

An existing-shelf fixture with 40 artists, three initially live artists, and
synthetic daily quotas of 40 metadata / 80 catalogue requests exposes its first
new artist after 2.00 virtual days; the full rebuild takes 12.00 days. It appends
286 recordings across 37 new artist buckets and finishes with all 308 expected
recordings. This was the completed-artist publication baseline. Batch publication
reduces the same fixture's first new artist to 54 virtual seconds, with 36 newly
published recordings before its first quota interruption. Full duration and
all 693 HTTP attempts remain unchanged; publication timing improves without
assuming more provider capacity. The completed-artist baseline soak with
1,600 artists, three initially live artists, synthetic
500 / 5,000 daily quotas, rolling limits, duplicate deliveries, three crashes
and a lost dispatch exposes its first new artist after 35 virtual minutes.
All 12,239 expected recordings and 1,600 artist buckets pass the final oracle;
the batch-publication soak also passes all final checks, with a peak of 43 SQL
statements and eight HTTP requests per delivery. A separate nine-artist fixture
with 12 releases each and one shared 100-call/hour quota publishes songs before
any artist finishes and before its first quota stop. These timings
are fixture results, not predictions of Spotify quota resets or live completion.

Reproduce with:

```bash
npm run simulate -- --artists 40 --initial-live-artists 3 --quota 40 --catalogue-quota 80
npm run simulate -- --scenario soak --initial-live-artists 3
```

## Compact operational history

Cooldown publication scans retain a durable cursor and empty-pass marker for
the current job revision. Duplicate delayed messages read the singleton job
instead of rescanning unchanged staging after a pass is exhausted. Source work
advances the revision, which starts a fresh pass and includes earlier artist/key
additions. The scan acquires the existing lease before reading candidates;
publication and its checkpoint commit together with generation/revision guards.
Migration `0023_never_isrc_lookup.sql` adds the missing Never ISRC index so the
recording-key, exact-id and ISRC alternatives can all use indexed lookups.

Migration `0020_operational_history.sql` adds:

- `refresh_history`: the latest 30 runs with start/end, outcome, error,
  progress, observed request totals, and observed refresh-queue D1 usage.
- `operational_activity`: hourly endpoint attempts, failures, rate-limit
  responses and refresh-queue row usage, retained for 30 days.
- `quota_interruptions`: endpoint, reason, observed time, next retry and timing
  source, retained for 30 days and capped at 2,000 on daily maintenance.

The authenticated owner panel has expandable history. `GET /api/owner/history`
is owner-only and returns at most 30 runs, 720 hourly records and 100 recent
interruptions. Stored rows contain no access/refresh tokens or response bodies.
Existing active counters are imported during upgrade; old completed runs and
historical billing are not invented or reconstructed.

New discoveries are measured at completion against the generation that was
live when the run started, applying the final known/Never filters. The API
reports `discoveriesPerRequest` for completed outcomes and `stagedPerRequest`
separately. A warm run can have many staged candidates but zero new discoveries.
The denominator is observed data requests, excluding token renewals. Failed or
active runs do not claim final discovery yield. Quarantine prevents replacement
of the original shelf; validated additions already published remain
available and are also counted in that run's final eligible discoveries.

The database observer records D1's own `meta.rows_read` and `meta.rows_written`
for `all`, `first`, `run` and each batch result. It does not substitute returned
row count or changed row count. `first` uses one `all` call so its metadata is
not discarded. See [D1 return metadata](https://developers.cloudflare.com/d1/worker-api/return-object/)
and [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/).

Stored totals cover refresh Queue invocations and exclude the final two metric
storage statements; they are labelled with `databaseScope` and
`rowMetricWritesExcluded`. Structured `database_usage` logs include those final
statements where metadata is returned, and log public/owner/scheduler usage
separately. Public requests add no metric-storage write per visitor. Hard
termination or errors without result metadata can leave observations incomplete.
Account-wide billing, migrations and other clients should still be checked in
Cloudflare's database analytics.

The SQLite simulator reports `rowsReturned` and `rowsChanged` as local
approximations. Even when it supplies D1-shaped metadata to the observer, those
values do not become scanned/indexed/billable Cloudflare row measurements.

## Reproducing the comparisons

```bash
npm run simulate -- --scenario warm --runs 3 --between-runs-seconds 604800
npm run test:simulator
npm run verify
```

For the asymmetric comparison, pass this JSON with `--config`, changing only
`scheduler` between `fair` and `serial` and choosing different report paths:

```json
{
  "artists": 6,
  "prolificArtistAlbums": 20,
  "trackQuota": 20,
  "scheduler": "fair"
}
```

Reports contain `firstQuotaCoverage`, `firstRecommendationSeconds`, final
oracle checks, request counts and local database/Queue costs. `availabilityChanges`
can be enabled for a two-run `warm` fixture with at least two albums and eight
tracks per album and a weekly interval to reproduce availability/relink changes.
