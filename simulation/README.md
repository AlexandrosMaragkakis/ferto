# Refresh simulator

Run FERTO's production refresh state machine against a synthetic Spotify API,
a simulated Queue, and a temporary file-backed SQLite database. The real SQL
migrations, pagination, caches, leases, cursor updates, retry policy, promotion
logic and public recommendation handler execute without modification.

Requires **Node.js 24 or newer** and the project's installed dependencies.

```bash
npm ci
npm run simulate
npm run simulate -- --scenario chaos
npm run simulate -- --scenario soak
npm run simulate -- --scenario warm
npm run test:simulator
```

The default smoke run is small. `soak` generates 1,600 artists and may take
around a minute, depending on hardware. Virtual days pass by jumping to the
next Queue delivery, quarter-hour watchdog or Sunday cron event; no real
cooldown sleeps are used.
All simulated timestamps start at **2026-10-18 03:00 UTC** and are unrelated to
the current wall clock. JSON output records both virtual and real durations.

## Scenarios

| Preset | Artists | Track quota | Other API quota | Rolling window | Faults / purpose |
| --- | ---: | --- | --- | --- | --- |
| `smoke` | 12 | 100,000 / day | 100,000 / day | Disabled | Complete cold refresh |
| `quota` | 40 | 40 / 48 hours | 80 / 48 hours | Disabled | Waits longer than Queue message retention |
| `chaos` | 40 | 40 / 2 hours | 100 / 2 hours | 12 calls / 30 seconds | Missing quota headers, two crashes, duplicates, lost/failed dispatches, API faults |
| `soak` | 1,600 | 500 / day | 5,000 / day | 20 calls / 30 seconds | Three crashes and the same API/dispatch faults at larger scale |
| `warm` | 40 | 100,000 / day | 100,000 / day | Disabled | Two refreshes on the same database, one hour apart |

**These limits are synthetic test inputs, not estimates of Spotify's actual
quotas.** Metadata lookups share one modeled quota bucket; other Web API
endpoints share another. Set `sharedQuota` / `--shared-quota` above zero to
replace both with one shared capacity for all data endpoints. Token requests
are counted separately. The model
uses fixed quota windows anchored to the virtual start and a separate rolling
rate window. It cannot infer real Spotify endpoint groupings or reset times.

Default fixtures contain liked tracks, owned and collaborative playlists,
unrelated followed playlists, permanent Never exclusions, id-only known
tracks, duplicate ISRCs across releases, relinked Spotify ids and unplayable
tracks. Increasing dataset sizes exercises the API's different page sizes.

API-fault presets additionally inject:

- Six consecutive 503 responses on Web API attempts 5–10, exercising the long
  upstream pause after short retries are exhausted.
- A network disconnect on attempt 23 and a revoked access token on attempt 25.
- A playlist disappearing after its first page. Its tracks overlap liked
  songs, so the independently expected exclusion set remains knowable.
- A playlist snapshot changing between listing and verification.
- Track 404s whose expected absence is included in the catalogue oracle.

The specified attempts are counted over all Web API calls, excluding token
requests, and fire once per simulation. Very small custom scenarios might
finish before every configured API fault occurs; inspect the fault counters.

## Custom workloads

```bash
# More releases and longer albums; choose a reproducible delivery seed.
npm run simulate -- --scenario chaos --artists 100 --albums 3 --tracks 60 --seed 17

# Explore a hypothetical metadata capacity; this does not change production.
npm run simulate -- --scenario quota --quota 100 --window-seconds 86400

# Explicit seconds, HTTP-date, and absent Retry-After headers are supported.
npm run simulate -- --scenario quota --retry-after date
npm run simulate -- --scenario quota --retry-after missing

# Check weekly identity reuse with fresh daily availability.
npm run simulate -- --scenario warm --between-runs-seconds 604800

# Start with a partial existing shelf and measure new-artist publication.
npm run simulate -- --artists 40 --initial-live-artists 3 --quota 40 --catalogue-quota 80
npm run simulate -- --scenario soak --initial-live-artists 3

# Model a shared quota bucket across all data endpoints.
npm run simulate -- --artists 9 --initial-live-artists 1 --albums 12 --shared-quota 100 --window-seconds 3600

# Verify fixed 30-day identity expiry rather than renewing cache hits.
npm run simulate -- --scenario warm --runs 6 --between-runs-seconds 604800

# Bound a run and preserve the reason it could not finish.
npm run simulate -- --scenario soak --max-days 7 --max-deliveries 5000

# Save a complete delivery trace as well as the JSON summary.
npm run simulate -- --scenario chaos --report simulation-results/custom.json --trace simulation-results/custom.jsonl
```

`npm run simulate -- --help` lists supported flags. `--config path.json`
accepts any field in `SimulationConfig` in [config.ts](config.ts); command-line
flags override the JSON file, which overrides its selected preset. Unknown
properties, invalid values and oversized workloads are rejected.

Example JSON configuration:

```json
{
  "scenario": "chaos",
  "seed": 17,
  "artists": 200,
  "trackQuota": 100,
  "quotaWindowSeconds": 86400,
  "maxVirtualDays": 120,
  "maxDeliveries": 50000
}
```

## Reports and correctness

The command writes `simulation-results/<scenario>-<seed>.json` by default.
These generated reports are ignored by Git. `--report` chooses another path;
`--trace` optionally writes every delivery, cron wake and crash as JSONL.
Successful runs exit **0**; unfinished runs, violated invariants and resource
budget breaches exit **1**. Invalid CLI/configuration input also exits 1.

The fixture independently derives its expected eligible recording set and
representatives from synthetic source facts. It does not call production
recording conversion, exclusion, selection or promotion helpers to decide
what should appear. Each completed refresh verifies:

- Exact equality of expected and published recording keys and representatives.
- Exclusion of liked/owned-playlist/collaborative-playlist/Never recordings,
  with unrelated followed playlists ignored.
- Completion of every seed artist and consistency of processed, discovered,
  cached, fetched and skipped track checks.
- Correct catalogue counts, staged counts, dense artist/track slots and bucket sizes.
- Harmless acknowledgement of a delayed delivery after the job has completed.
- Valid public recommendation draws, including exclusion of the current card.
- Correct seed-artist assignments and retention of permanent Never decisions.
- Retention of earlier promoted generations across repeated runs.
- Foreign-key integrity and SQLite's integrity check.
- Accurate persisted request totals, allowing observation loss on an injected
  hard termination; fake API counters retain all attempts.

The runner also rejects requests made before an explicit Retry-After deadline
in a subsequent invocation. Requests already in the same invocation's
concurrent group may finish after a sibling first returns 429.

Reports include per-endpoint attempts and failures, quota/rate-limit events,
virtual time, Queue retries/duplicates/expired messages/dead letters, observed
crashes, weekly cron wakes and watchdog ticks/recovery wakes, cache/progress
counters, and maximum SQL/HTTP counts per invocation. Completed jobs can leave
delayed duplicate/cron messages in the simulated
queue; their count is reported and stale-delivery handling is checked.
Failure reports retain the unfinished phase, revision,
lease/retry deadlines, saved counters and recent events/API errors/Worker logs.

`firstQuotaCoverage` counts artists with staged results at the first quota
interruption; `firstRecommendationSeconds` measures when a shelf first becomes
available in that run (zero when an earlier shelf already exists). JSON config
can set `initialLiveArtists` (CLI `--initial-live-artists`) to seed an existing
shelf from that many artists' independently expected eligible recordings.
`firstIncrementalPublicationSeconds` measures the first validated-batch append;
`firstNewArtistSeconds` measures growth beyond the initial artist-bucket count.
Both are null if the event never occurs. Persisted `publishedRecordings` and
`publishedArtists` counters describe additions made before final replacement.
`artistsCompletedAtFirstPublication` shows whether any artist had finished then;
`firstQuotaPublishedRecordings` counts published additions at the first observed
quota stop. Together they verify that incomplete artists can provide useful
public songs before a wait, under separate or shared quota models.
JSON config
can set `prolificArtistAlbums` to give artist one extra releases and compare
`scheduler: "fair"` against `scheduler: "serial"`. `availabilityChanges: true`
changes eligibility and one relink before run two; use a weekly `warm` fixture
with at least two albums and eight tracks per album. See
[measurements and assessment](../docs/refresh-engine.md).

## Runtime model and limits

- `scripts/simulate.mjs` uses the existing Vite JavaScript API with config and
  environment-file loading disabled. It bundles only the local simulator
  entry and production modules, not the app's deployment plugin/configuration.
- Only synthetic credentials are supplied. All outgoing fetches are replaced
  with the fake API; unknown hosts, methods or routes cause failure. No live
  Spotify calls, Cloudflare calls, project `.dev.vars`, production databases
  or local `.wrangler` state are used.
- Every run uses an operating-system temporary directory. SQLite and compiled
  bundles are cleaned up on normal completion or handled failure. JSON reports
  and explicitly requested traces remain at their selected output paths.
- A hard termination is injected before the ninth SQL statement of an
  enrichment invocation. The adapter rejects subsequent SQL, rolls back any
  open transaction and reopens the same database file. Queue messages survive
  independently; redelivery must respect the existing lease and checkpoints.
- A dispatch failure throws before enqueue; a deliberately lost dispatch
  reports success without delivering. The production quarter-hour watchdog
  recovers overdue active work after a two-minute grace beyond all gates;
  the Sunday cron still starts new generations. Fresh sends get fresh retention
  and retry budgets; retries retain their original creation time. The queue
  models 24-hour retention, up to
  eight retries, serialized consumers, deterministic duplicates and delay
  enforcement. Duplicates preserve their message id and enqueue time, and use
  an incremented attempt number.
- The SQLite adapter supports the D1 methods the app currently uses. Unsupported
  methods fail explicitly. It enforces 100 bound parameters and the configured
  statement budget; HTTP requests have a separate configured invocation budget.
- `rowsReturned` and `rowsChanged` describe local SQLite statement results.
  **They are not D1 scanned, indexed or billable row counts.** Cloudflare CPU,
  storage quotas, network latency, read replication and parallel consumer races
  are not modeled. Keep running the existing Cloudflare integration tests.
- Simulations temporarily replace the process's `fetch`, `Date.now`, random
  source and Worker logging, restoring them even after failure. Run simulations
  sequentially within one Node process, or use separate CLI processes.

The simulator reports behavior under chosen conditions. A passing run proves
its checked invariants for that fixture and fault sequence; it does not prove
all failures, schedules or real provider limits have been covered.
