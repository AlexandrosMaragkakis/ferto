# D1 capacity safeguards roadmap

**Status:** Implemented and deployed; final live-maintenance evidence is being
recorded below.

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

**Status:** Implemented, verified and deployed.

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
archive remained unchanged. Detailed evidence is private. These initial local
checks were followed by the release verification in milestone 4.

Album-availability markers, playlist snapshots and service-token cleanup keep
their existing policies in this milestone. This does not introduce catalogue
pruning or promise a particular reduction in Cloudflare's physical size.

## 2. Handle storage failures safely

**Status:** Implemented, verified and deployed.

- [x] Distinguish documented storage-exhaustion errors from daily row quotas,
  transient failures and unrelated SQL errors. Return useful sanitized messages.
- [x] Address public discovery's dependency on writable request-budget rows
  while retaining shared rate-limit and abuse protection.
- [x] Handle Spotify-confirmed Add operations whose local bookkeeping fails,
  with an explicit partial outcome and a safe recovery/reconciliation path.
  Preserve the displayed card and authoritative Never decisions on failures.
- [x] Give refresh deliveries capacity-specific recovery behavior, preserving
  generation/cursor state and preventing an uncontrolled retry loop.
- [x] Turn the investigation's synthetic failure probes into regression tests,
  including public draws, Add, Never, scheduled work and queue redelivery.

**Done when:** storage errors have tested user-visible outcomes, no owner action
is falsely reported as saved, and browsing protection and recovery remain sound.

Strict shared request counters and pending save receipts now live in a small
SQLite-backed `StorageControl` Durable Object, independently of catalogue D1.
The existing per-client/global limits remain enforced. Admission fails closed
if that object is unavailable. An Add persists an intent before contacting
Spotify; a confirmed provider save followed by failed local bookkeeping returns
an explicit HTTP 202 partial result and retains the card. Confirmed receipts
reconcile without another Spotify mutation. Unknown provider outcomes require
an explicit owner retry. Never remains authoritative only after D1 succeeds.
Capacity-failed queue deliveries acknowledge and retain their job/cursors;
the existing watchdog resumes them after recovery instead of spending retries.

**Validation:** 22 storage-control/failure regression cases pass, including real
D1/DO integration, eviction persistence, strict budgets with rejected D1 writes,
partial/unknown saves, unavailable coordination, duplicate deliveries and a real
recovery write probe. Desktop/mobile browser checks cover warnings, paused
polling, partial Add retries and failed Never without losing the card.

## 3. Warn and pause growth before exhaustion

**Status:** Implemented, verified and deployed.

- [x] Measure capacity using supported D1 metadata with bounded overhead.
  Include index writes in the maintenance budget and account-wide daily usage.
- [x] Select warning/pause/resume thresholds from measured growth and essential
  write needs, with hysteresis and sufficient operating headroom.
- [x] Show the owner a clear capacity warning and a persistent background-growth
  pause. Weekly/manual wakes must respect the pause until recovery is confirmed.
- [x] Test threshold crossings, stale measurements, restarts, duplicate queue
  deliveries, essential owner operations and safe resumption.

**Done when:** background expansion stops before consuming essential headroom
and the owner can understand the state and recover safely.

The owner sees a warning at 375 MB (75%). Background growth pauses at 400 MB
(80%), leaving 100 MB of storage headroom; a storage pause resumes at or below
350 MB (70%) only after a bounded D1 write probe succeeds. Supported `size_after`
metadata comes from one constant query, cached for five minutes and forced
after quarter-hour maintenance. Measurements and pauses survive Worker/DO
restarts; older measurements cannot replace newer ones. Manual and weekly wakes
respect the pause, while essential owner operations and bounded cleanup remain
available when their dependencies permit them.

The DO also pauses background work at 3.5 million observed D1 reads or 70,000
observed writes per UTC day. These are this Worker's measurements, including
index costs reported by D1, not account-wide counters. Actual documented daily
quota failures persist a pause until the next UTC day. Account-wide GraphQL
usage is checked separately through `ops:status`; other apps, CLI commands and
the DO's own Free-plan allowances remain separate. See the
[capacity and recovery procedure](../retention.md) for limits and recovery.

## 4. Verify release behavior and actual storage recovery

**Status:** Production release complete; observing the first maintenance tick.

- [x] Run full verification, secret checks and dependency audit for each release.
- [x] Use a verified pre-release backup and the existing deployment safeguards.
- [ ] Compare Cloudflare's real storage and daily read/write metrics before and
  after bounded maintenance; distinguish reusable pages from physical reclaim.
- [x] Confirm public browsing, owner-action authorization, queue delivery and
  retained refresh state after release. Verify positive owner-save/failure paths
  on real Worker/D1/DO bindings with synthetic Spotify responses; avoid test
  mutations to the production library. Retain recovery evidence privately.

**Done when:** release evidence confirms the intended behavior and measured
costs. Further retention changes require evidence that these safeguards are
insufficient; permanent data and stale-card identities remain protected.

**Release validation:** all 572 CI checks pass, including 382 Worker/integration,
36 simulator, 67 operations and all 64 desktop/mobile browser checks. The
installer privilege check also passes in CI. TypeScript, production build and
Wrangler dry-run pass.
Dependency audit reports zero vulnerabilities and the publication scan passes.
The additive Durable Object binding/class migration is included in the release;
no D1 SQL migration or billing change is required. Production CI/CD performs a
fresh verified encrypted backup, pauses/drains delivery, verifies deployment and
resumes the queue.

The capacity implementation merged in [PR #17](https://github.com/AlexandrosMaragkakis/ferto/pull/17).
Release verification exposed delayed visibility of newly uploaded GitHub
artifacts. [PR #18](https://github.com/AlexandrosMaragkakis/ferto/pull/18) adds
bounded REST-backed downloads for all artifact handoffs, retaining exact backup
ciphertext and complete release-manifest checks. The initial attempts stopped
before live changes. Seven regressions cover that handoff and integrity behavior.

[Production release 800eef86c352](https://github.com/AlexandrosMaragkakis/ferto/actions/runs/45380877656)
completed the verified backup, full 16-minute drain, additive DO class migration,
deployment, smoke checks and confirmed queue resumption. Its encrypted backup
was also downloaded, decrypted and restore-verified locally; encrypted operational
evidence and the matching release receipt are retained privately.

Independent live verification matches all 18 deployed asset hashes and passes
27 asset/API/security checks, including anonymous authorization and CSRF probes.
Desktop/mobile browsing, cached Back, theme persistence and narrow layout pass
with no JavaScript errors. Observed public draws write zero D1 rows while the
durable budget remains active. The queue consumer processed a delivery and
preserved the existing provider wait; source advancement correctly waits for
that deadline. Positive and partial owner-save paths were tested locally, using
synthetic provider responses. Verification makes no production Spotify writes.
