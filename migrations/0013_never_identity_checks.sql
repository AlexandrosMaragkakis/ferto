-- Spotify Development Mode removed Track.linked_from in February 2026. Before
-- catalogue discovery, FERTO now resolves every permanent exact-id exclusion
-- directly so the request id can be joined to the returned track's ISRC even
-- when Spotify substitutes a different market-playable id.
--
-- Expected 403/404/no-ISRC results must not block the current rebuild, so this
-- small table records the last rebuild in which each exact id was checked.
-- Unresolved rows are tried again by later weekly rebuilds.
CREATE TABLE IF NOT EXISTS never_identity_checks (
  spotify_id TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL
);

-- A rebuild that was already in flight when this migration landed would
-- otherwise skip the new safety phase. Reroute it and invalidate its old Queue
-- revision; seed scanning is idempotent, so restarting that crawl is safe.
UPDATE rebuild_jobs
SET phase = 'never_identities',
    cursor = NULL,
    work_key = NULL,
    lease_until = NULL,
    retry_at = NULL,
    retry_count = 0,
    next_read_at = 0,
    revision = revision + 1,
    dispatch_pending = 1,
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE singleton = 1 AND status = 'active';
