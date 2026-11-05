# Operations and catalogue behavior

This guide explains how discovery, exclusions, refreshes and quotas behave.
For operator commands, use [self-hosting and upgrades](self-hosting.md#deploying);
for resource settings, see [configuration](configuration.md).

## Operational behavior

- **Scheduled and owner-started rebuilds**: the Worker rebuilds the catalogue
  every Sunday at 03:00 UTC (cron `0 3 * * SUN`). An authenticated owner may also
  start a rebuild immediately when idle or replace a failed rebuild from the
  status panel with `POST /api/owner/refresh`. Posting while work is active
  safely re-sends its durable wake-up without creating a second generation or
  bypassing a quota cooldown;
  opening the authenticated owner panel performs that wake-up automatically.
- **Stalled-work watchdog**: a separate `*/15 * * * *` cron checks the active
  job every 15 minutes. After a two-minute grace beyond its latest update,
  lease, pacing gate and retry deadline, it requeues the current generation
  and revision. It never starts idle/failed work or changes the Sunday schedule.
  This recovers a lost wake without waiting for the next weekly refresh.
- **Serialized queue**: the rebuild runs through a Cloudflare Queue consumer
  configured for one message, one batch, and one concurrency, plus a D1 lease,
  so exactly one rebuild generation progresses at a time. Work advances one
  Spotify page or bounded track batch per delivery. Page reads start with a
  two-second gap; a batch of 30 metadata requests waits at least 30 seconds.
  Rolling 429s honor `Retry-After`, double a durable pacing multiplier (capped
  at 30), and reduce metadata batch size and concurrency. Every 20 clean data
  units reduce the multiplier by 10%, down to its baseline. Development Mode `QUOTA_EXCEEDED` responses
  preserve the same generation and honor a valid `Retry-After` (seconds or an
  HTTP-date). Without provider timing, one-request metadata probes back off
  through 15m, 30m, 1h, 2h, 4h, then at most 6h. A successful data request
  records the observed recovery time and restores normal batches. These are
  next-attempt times, not promised Spotify quota resets. Long waits are re-dispatched in 12-hour chunks against the
  full durable deadline so delayed messages survive the live queue’s 24-hour
  retention window. Quota waits consume no retry attempt. 5xx errors back
  off exponentially, then pause for one hour after five attempts and resume
  with a fresh short-retry budget; permanent systemic failures
  keep the existing shelf and any validated additions available until a
  fresh generation is started.
- **Incremental source reads**: artist release lists are checked for new
  releases on every rebuild. Album-track discovery pages retain requested ids
  and pagination cursors for 30 days, scoped by client, owner, and market.
  Album availability is checked daily: an expired availability page is fetched
  again even while its discovery ids remain reusable. New album ids are always
  fetched. Full track metadata is needed only for missing/expired identity,
  absent availability flags or changed relinks. Current exclusions are always
  reapplied. Identity alone never establishes playability.
- **Fair artist turns**: new and upgraded jobs rotate by persisted per-artist
  turn counts within a working group of at most eight artists. Admission favours
  artists missing from the live shelf and discovery already started; completion
  frees a place for another. After quota waits, queued song/release work comes
  before cold release-list reads.
  A turn reads one page or at most five uncached track ids while
  multiple artists remain. Cached metadata can still fill a 30-track batch;
  the last artist can use the full request batch. Cursors and unfinished ids
  remain durable across yields, quota waits and duplicate deliveries. Completed
  artist rows are removed with the completion counter. First-install results
  appear early. Subsequent refreshes publish new eligible recordings from
  each validated song batch into the existing shelf, preserving its existing cards;
  final replacement still uses atomic promotion and the original overlap gate.
- **Useful work during quota waits**: a delivery may publish up to 30 already
  validated staged recordings using only D1. It makes no Spotify/token requests
  and preserves source cursors, revision, and retry/pacing deadlines. An explicit
  owner wake can start publication immediately while the provider wait remains
  visible. New liked exclusions and learned aliases also exclude early public
  copies, including after a quarantined rebuild. Already public keys skip
  redundant publication writes during warm refreshes. Spotify quota buckets
  have undisclosed, changeable groupings, so an endpoint's rejection still
  pauses all Spotify requests; see [quota counting](https://developer.spotify.com/documentation/web-api/concepts/quota-modes#quota-counting).
- **Playlist snapshots**: only currently owned or collaborative playlists may
  reuse exclusions. A matching `snapshot_id` from fresh playlist discovery can
  copy a previously completed snapshot directly into the new generation.
  Changed, absent, expired (30 days), or context-mismatched snapshots are read
  page by page. A final snapshot check publishes the cache only when the
  version still matches; incomplete or edited scans are never reused. An empty
  playlist needs the same completion check. Cached exclusions store exact ids
  and recording keys in compact pages, not private playlist names or artwork.
  Reuse copies one page per delivery, bounding D1 work for large playlists.
- **Known-track filtering**: exact liked/playlist ids with a confirmed canonical
  ISRC and resolved Never ids are skipped before enrichment, including in
  already-queued legacy batches. Id-only exclusions still receive identity
  lookups, and learned canonical aliases are excluded before equivalent
  recordings can be staged. A final authoritative liked-song scan remains.
- **Service-token reuse**: the rebuild reuses its access token until one minute
  before expiry, with an upper cache lifetime of 59 minutes. D1 holds only
  AES-GCM ciphertext bound to the runtime session secret and credential/owner
  fingerprint. Credential or secret rotation invalidates the cache. Preflight
  still obtains a fresh token and checks scopes and owner identity. A rejected
  token is refreshed once per invocation, shared by concurrent requests; a
  second 401 fails visibly. Interactive owner writes retain their existing
  authorization flow.
- **Bounded writes and measurements**: recording staging uses one set-based
  SQL write after representative selection, leaving space for identity and
  cache checks within the invocation budget. Structured logs report data-read
  counts, pacing delays, metadata cache hits, source reuse, and skipped known
  ids. Tokens are never logged. Fewer SQL statements reduce invocation cost;
  inserted/indexed rows still count toward D1's daily write allowance.
- **Partial metadata progress**: enrichment and Never identity checks save
  successful requests even when another request in their concurrent group
  fails, then retry only unfinished ids. A bounded metadata cache avoids repeat
  full-track reads across releases, delivery retries, and nearby generations;
  owner and market isolation prevent stale cross-account playability reuse.
  Full responses expire after one day. A separate 30-day identity cache omits
  availability, restrictions and relinking flags. Fresh album pages provide
  daily availability only when returned ids match the cached identity; missing
  flags or changed relinks force a full lookup. Hits never extend identity
  expiry. Metadata corrections can wait for identity expiry; availability
  changes are picked up by the next refresh after its daily snapshot expires.
  Migration `0019_identity_availability_and_artist_turns.sql` caps older
  full-response/page caches to one day without erasing active work.
  The owner panel distinguishes quota waits, rolling rate limits, and temporary
  Spotify errors, shows the next attempt and whether Spotify or backoff chose
  its timing, and keeps progress counts visible during a pause. The existing
  catalogue stays available. Long waits poll once
  per minute instead of every ten seconds.
- **Persistent owner progress**: migration `0018_refresh_progress.sql` adds
  small JSON counters to the job and retains the latest completed run in
  `refresh_state`. Seed totals are unique artist ids; artist completion is
  saved with removal of its finished work. Song checks count discovery work,
  including repeated appearances of a Spotify id across releases; they are
  split into completed Spotify lookups, cache hits, and known skips. The
  denominator is discoveries so far, not a predicted final song count.
  Staged recordings count distinct recording keys, not final eligible picks.
  Progress increments commit with their source cursor/queue changes, so
  duplicate deliveries and partial failures cannot double-count completed work.
  Early-publication counters show recordings and new artist buckets already
  available, with the latest publication time during active work.
  Status polling reads only two singleton rows. Existing in-flight work is
  marked partial because older deployments deleted completed work rows.
- **Request observations**: refresh HTTP attempts (including token renewals,
  retries, network failures, and 429s) are aggregated per endpoint category,
  with last attempt/success times. One write at the end of each invocation
  avoids per-request database writes. An invocation killed before that write
  can leave observations incomplete; counts also exclude interactive owner
  actions and other apps sharing the Spotify developer account. They describe
  observed refresh activity, not remaining Spotify quota. Status exposes
  `requestCountBasis: "observed"`, and the owner panel explains these gaps.
  Successful quota probes record an observed recovery interval, not the exact
  reset instant.
- **Legacy Never identity gate**: after owner/account preflight and before any
  catalogue discovery, unresolved exact-id exclusions are checked in bounded
  batches of 30. Successful ISRC matches permanently strengthen the exclusion;
  unavailable ids advance the current rebuild and are retried the following
  week, so neither a bad object nor Spotify relinking can block the refresh or
  resurrect a rejected recording.
- **Bounded work-queue reads**: completed or skipped artist, release, and
  playlist work rows are deleted as soon as they are processed; warnings are
  aggregated separately. Pending selection therefore does not scan an
  ever-growing prefix of completed work, avoiding quadratic D1 row reads
  without extra indexes.
- **Bounded status reads**: the authenticated owner panel polls at ten-second
  intervals (once per minute during long waits) and reads only the singleton
  job/state rows. It reports the durable
  phase rather than repeatedly counting every staging table, so leaving the
  panel open cannot turn a long rebuild into catalogue-sized D1 reads.
- **D1 staging and safe first shelf**: an empty installation first freezes its
  liked-song and playlist exclusions, then exposes a safe, growing shelf as
  eligible recordings are discovered. Later rebuilds stage recordings in a
  separate generation, appending validated song batches to the live shelf
  with atomic, exclusion-filtered publication batches. A per-refresh ledger
  keeps these additions outside the original similarity baseline. Final
  replacement uses an atomic D1 batch. An empty rebuild
  never promotes. A rebuild sharing less than half of the live shelf is
  quarantined once (`pending_low`); a second completed low-overlap rebuild
  promotes anyway. Failure or quarantine preserves the existing shelf and
  already published additions. Replaced generations are retained.
- **Bounded public draws**: promotion materializes dense artist and track slots.
  A request reads cached shelf counts, one artist slot, and one track slot; it
  never runs catalogue-wide `COUNT`, `DISTINCT`, or `ORDER BY RANDOM()`.
  Like/Never compacts slots immediately, while a stale externally-liked slot is
  discarded lazily and repaired without a full scan.
- **D1 plan sizing**: the public/request paths are designed for D1 Free, but a
  full rebuild still has to write every discovered recording, work item, index,
  and recommendation slot. Cloudflare currently allows 5 million rows read and
  100,000 rows written per day on Free. Rebuild cost is workload-dependent
  (artists, releases, tracks, playlists, deduplication, and existing indexes),
  so no track-count threshold can guarantee that arbitrary libraries fit the
  daily write allowance. Free is the intended target for small personal
  catalogues; inspect D1 usage after the first rebuild and use D1 Paid before a
  large or repeated manual rebuild. A quota failure leaves the prior live shelf
  available, including completed publications; once D1 accepts writes again,
  starting a fresh rebuild replaces
  the failed job. See [D1 pricing and limits](https://developers.cloudflare.com/d1/platform/pricing/).
- **Catalogue**: seeds come from the first credited artist of each liked song;
  their albums and singles are crawled (skipping vanished artists with a
  warning); strictly playable tracks are enriched with individual Spotify
  `GET /tracks/{id}` requests and deduplicated per recording (ISRC-first
  identity, one representative — earliest release, then artwork, then smallest
  id). Liked songs plus owner-owned and collaborative playlist items define the
  known-track exclusion set. Market is optional because a user token lets
  Spotify apply the account's country when `/me` omits it.
  Public playlists that the owner merely follows are intentionally not counted:
  Spotify does not reliably expose their items to Development Mode apps, so
  FERTO does not pretend those tracks are part of the "already heard" set.
- **Public read-only**: visitors can only draw recommendations. There are no
  public write endpoints, and the recommendation response exposes no refresh
  or identity internals. The draw is uniform over artists first, then uniform
  within the chosen artist, so prolific artists don't flood the site. The
  `exclude` parameter skips only the current track for that single request.
- **Owner actions**: **Like** saves to Spotify first through the current generic
  `PUT /me/library` endpoint; a stale id-only card first receives a read-only
  metadata lookup so its ISRC can be matched to a newer representative. Only
  after Spotify confirms the save is the recording excluded locally — from a
  single consistent live/staging snapshot, recording-wide across promotion.
  If identity confirmation or the Spotify save fails, the candidate stays on
  the shelf. **Never** uses the stored ISRC identity when available, otherwise
  performs one fallback track-metadata lookup; on a transient lookup failure it
  fails closed (nothing stored) so the exclusion is never weakened. Never
  exclusions are permanent and survive every rebuild, whichever representative
  Spotify later serves.
- **Playback**: there is none of our own — tracks play in the official
  Spotify compact embed, so no playback token, secret, or custom player
  exists anywhere.
