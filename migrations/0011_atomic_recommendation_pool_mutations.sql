-- D1 batches are atomic, but values read before a batch can go stale while a
-- second request mutates the same dense slot range. Each removal snapshots its
-- compaction plan into this short-lived row *inside* the mutation batch, so all
-- reads and writes serialize as one database transaction.
CREATE TABLE recommendation_pool_removals (
  operation_id TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  recording_key TEXT NOT NULL,
  bucket_artist_id TEXT NOT NULL,
  track_slot INTEGER NOT NULL,
  bucket_slot INTEGER NOT NULL,
  track_count INTEGER NOT NULL,
  last_track_recording_key TEXT NOT NULL,
  last_bucket_artist_id TEXT NOT NULL
);

-- Bootstrap appends use SQLite changes() to capture their exact idempotent
-- delta without repeatedly COUNTing the growing catalogue (an O(N²) D1-read
-- pattern). The row exists only for the duration of the atomic batch.
CREATE TABLE recommendation_pool_appends (
  operation_id TEXT PRIMARY KEY,
  inserted_count INTEGER NOT NULL,
  bucket_inserted INTEGER NOT NULL DEFAULT 0
);
