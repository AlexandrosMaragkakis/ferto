# D1 capacity safeguards roadmap

**Status:** Implementation started on `feat/d1-capacity-safeguards`.

**Updated:** 24 November 2026. This replaces the initial discussion-only task.

## Objective and boundaries

Control avoidable storage growth and make storage exhaustion safe and visible.
Keep the existing Free-plan setup, public discovery and owner authorization.
Preserve live and promoted catalogue generations, active work, permanent Never
decisions and the identity mappings required by older cards.

The investigation found that expired caches can accumulate during a refresh
that runs for weeks. Their deletion was tied to starting a new refresh.
It also reproduced failed public draws and partially completed owner actions
when D1 rejects writes. Detailed backup measurements and experiments remain
in private ignored reports.

The existing [retention preview](../retention.md),
[operations status](../../scripts/operations-status.mjs) and
[backup/release safeguards](../backups-and-recovery.md) remain the starting point.

## 1. Bound expired-cache maintenance

**Status:** Implemented and verified locally; not deployed.

- [x] Clean expired full-track, recording-identity, track-availability and
  album-discovery cache rows on the existing 15-minute watchdog, independently
  of whether refresh work is idle, active, quota-waiting or failed.
- [x] Use expiry indexes and cap each table at 32 deletions per tick. Remove
  these tables' bulk deletions from refresh startup. Preserve fresh rows and
  the album-availability markers needed to invalidate reusable discovery pages.
- [x] Record actual D1 row metadata and deletion counts without storing a new
  metric row per cleanup. A cleanup failure must not prevent watchdog recovery.
- [x] Test backlog bounds/draining, TTL boundaries, preservation, concurrent
  cache refreshes, transaction failures, real D1 read/write costs and continued
  watchdog behavior. Run the complete repository verification.

**Done when:** a long-running refresh no longer prevents these caches from
being cleaned; each invocation has a measured, bounded cost; preservation and
watchdog regression checks pass. No new binding or migration is required.

**Validation:** full repository verification passed, including 11 new cache
regressions and all 56 browser checks. The real D1 test binding stayed within
512 rows read and 384 rows written for a full 128-row cleanup batch surrounded
by thousands of fresh entries. Dependency audit and publication scans passed.
A disposable restore of the latest verified backup drained the fixed-cutoff
backlog with at most 32 deletions per table per tick; hashes of all 38 other
tables stayed unchanged, integrity and foreign keys passed, and the input
archive remained unchanged. Detailed evidence is private. These local checks
do not establish production storage recovery or complete milestones 2–4.

Album-availability markers, playlist snapshots and service-token cleanup keep
their existing policies in this milestone. This does not introduce catalogue
pruning or promise a particular reduction in Cloudflare's physical size.

## 2. Handle storage failures safely

**Status:** Planned; not implemented by milestone 1.

- [ ] Distinguish documented storage-exhaustion errors from daily row quotas,
  transient failures and unrelated SQL errors. Return useful sanitized messages.
- [ ] Address public discovery's dependency on writable request-budget rows
  while retaining shared rate-limit and abuse protection.
- [ ] Handle Spotify-confirmed Add operations whose local bookkeeping fails,
  with an explicit partial outcome and a safe recovery/reconciliation path.
  Preserve the displayed card and authoritative Never decisions on failures.
- [ ] Give refresh deliveries capacity-specific recovery behavior, preserving
  generation/cursor state and preventing an uncontrolled retry loop.
- [ ] Turn the investigation's synthetic failure probes into regression tests,
  including public draws, Add, Never, scheduled work and queue redelivery.

**Done when:** storage errors have tested user-visible outcomes, no owner action
is falsely reported as saved, and browsing protection and recovery remain sound.

## 3. Warn and pause growth before exhaustion

**Status:** Planned; thresholds and persistence design remain to be selected.

- [ ] Measure capacity using supported D1 metadata with bounded overhead.
  Include index writes in the maintenance budget and account-wide daily usage.
- [ ] Select warning/pause/resume thresholds from measured growth and essential
  write needs, with hysteresis and sufficient operating headroom.
- [ ] Show the owner a clear capacity warning and a persistent background-growth
  pause. Weekly/manual wakes must respect the pause until recovery is confirmed.
- [ ] Test threshold crossings, stale measurements, restarts, duplicate queue
  deliveries, essential owner operations and safe resumption.

**Done when:** background expansion stops before consuming essential headroom
and the owner can understand the state and recover safely.

## 4. Verify release behavior and actual storage recovery

**Status:** Pending a reviewed release; implementation does not deploy itself.

- [ ] Run full verification, secret checks and dependency audit for each release.
- [ ] Use a verified pre-release backup and the existing deployment safeguards.
- [ ] Compare Cloudflare's real storage and daily read/write metrics before and
  after bounded maintenance; distinguish reusable pages from physical reclaim.
- [ ] Confirm public browsing, owner actions, queue delivery and refresh progress
  after release. Retain recovery evidence privately.

**Done when:** release evidence confirms the intended behavior and measured
costs. Further retention changes require evidence that these safeguards are
insufficient; permanent data and stale-card identities remain protected.
