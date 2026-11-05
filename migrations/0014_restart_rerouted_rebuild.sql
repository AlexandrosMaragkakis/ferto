-- 0013 rerouted any active job to the new Never-identity gate. A job that had
-- already catalogued its current seed could otherwise retain unreachable work
-- rows when the seed scan restarted. Clear all derived work for that private
-- generation and reroute once more. Staged recordings are retained because
-- their writes are idempotent; bootstrap-live dense slots remain safe.
DELETE FROM rebuild_seed_artists
WHERE generation = (SELECT generation FROM rebuild_jobs WHERE singleton = 1 AND status = 'active');

DELETE FROM rebuild_album_queue
WHERE generation = (SELECT generation FROM rebuild_jobs WHERE singleton = 1 AND status = 'active');

DELETE FROM rebuild_enrich_queue
WHERE generation = (SELECT generation FROM rebuild_jobs WHERE singleton = 1 AND status = 'active');

DELETE FROM rebuild_playlist_queue
WHERE generation = (SELECT generation FROM rebuild_jobs WHERE singleton = 1 AND status = 'active');

DELETE FROM rebuild_known_recordings
WHERE generation = (SELECT generation FROM rebuild_jobs WHERE singleton = 1 AND status = 'active');

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
