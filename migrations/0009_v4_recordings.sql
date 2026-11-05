-- FERTO v4: recording identity, private staging, live-only public shelf.
-- A recording is identified by ISRC when known, otherwise by its Spotify track
-- id. One representative row per recording is kept per generation. Generations
-- that were ever promoted (live) are retained indefinitely, while staging that
-- never promoted is discardable.
CREATE TABLE IF NOT EXISTS recordings (
  generation TEXT NOT NULL,
  recording_key TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  isrc TEXT,
  title TEXT NOT NULL,
  album_name TEXT NOT NULL,
  release_date TEXT,
  image_url TEXT,
  spotify_url TEXT NOT NULL,
  artists_json TEXT NOT NULL,
  bucket_artist_id TEXT NOT NULL,
  PRIMARY KEY (generation, recording_key)
);
CREATE INDEX IF NOT EXISTS recordings_bucket ON recordings(generation, bucket_artist_id);
CREATE INDEX IF NOT EXISTS recordings_spotify_id ON recordings(generation, spotify_id);

-- Registry of generations that were ever promoted to the public live shelf.
CREATE TABLE IF NOT EXISTS recording_generations (
  generation TEXT PRIMARY KEY,
  promoted_at INTEGER NOT NULL
);

-- Permanent exclusions are recording-wide and deliberately refresh-independent.
CREATE TABLE IF NOT EXISTS never_recordings (
  recording_key TEXT PRIMARY KEY,
  isrc TEXT,
  spotify_id TEXT NOT NULL,
  excluded_at INTEGER NOT NULL
);

-- Private per-generation staging work queues for the v4 rebuild algorithm.
CREATE TABLE IF NOT EXISTS rebuild_seed_artists (
  generation TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  cursor TEXT,
  PRIMARY KEY (generation, spotify_id)
);
CREATE TABLE IF NOT EXISTS rebuild_album_queue (
  generation TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  bucket_artist_id TEXT NOT NULL,
  album_name TEXT NOT NULL,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  cursor TEXT,
  PRIMARY KEY (generation, spotify_id)
);
CREATE TABLE IF NOT EXISTS rebuild_enrich_queue (
  generation TEXT NOT NULL,
  seq INTEGER NOT NULL,
  bucket_artist_id TEXT NOT NULL,
  track_ids_json TEXT NOT NULL,
  PRIMARY KEY (generation, seq)
);
CREATE TABLE IF NOT EXISTS rebuild_playlist_queue (
  generation TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  cursor TEXT,
  PRIMARY KEY (generation, spotify_id)
);
CREATE TABLE IF NOT EXISTS rebuild_known_recordings (
  generation TEXT NOT NULL,
  recording_key TEXT NOT NULL,
  PRIMARY KEY (generation, recording_key)
);

-- Only one rebuild job can exist: an active job, or a terminally failed job
-- kept visible until the next scheduled tick replaces it.
CREATE TABLE IF NOT EXISTS rebuild_jobs (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'failed')),
  phase TEXT NOT NULL,
  market TEXT,
  cursor TEXT,
  work_key TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  retry_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_read_at INTEGER NOT NULL DEFAULT 0,
  dispatch_pending INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE refresh_state ADD COLUMN live_generation TEXT;
ALTER TABLE refresh_state ADD COLUMN pending_low INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refresh_state ADD COLUMN last_outcome TEXT;
ALTER TABLE refresh_state ADD COLUMN last_outcome_at INTEGER;
ALTER TABLE refresh_state ADD COLUMN next_refresh_at INTEGER;
ALTER TABLE refresh_state ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '{}';

-- Existing live candidates become a retained live generation keyed by their
-- Spotify id (their ISRC is unknown until the next full rebuild replaces them).
INSERT INTO recording_generations (generation, promoted_at) SELECT 'legacy-live', CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE EXISTS (SELECT 1 FROM candidate_tracks);
INSERT INTO recordings (generation, recording_key, spotify_id, isrc, title, album_name, release_date, image_url, spotify_url, artists_json, bucket_artist_id)
SELECT 'legacy-live', 'spotify:' || spotify_id, spotify_id, NULL, title, album_name, NULL, image_url, spotify_url, json_array(json_object('id', artist_id, 'name', artist_name)), artist_id
FROM candidate_tracks;

-- Legacy Never rows are preserved as recording-wide exclusions under the same
-- spotify: identity until the owner re-confirms them with an ISRC lookup.
INSERT INTO never_recordings (recording_key, isrc, spotify_id, excluded_at)
SELECT 'spotify:' || spotify_id, NULL, spotify_id, excluded_at FROM never_tracks;

-- Any in-flight legacy refresh state is discarded and the v4 rebuild starts clean.
DELETE FROM refresh_jobs;
DELETE FROM refresh_staging_tracks;
DELETE FROM refresh_known_tracks;
DELETE FROM refresh_liked_artists;
DELETE FROM refresh_playlist_queue;
DELETE FROM refresh_album_queue;

UPDATE refresh_state SET live_generation = (SELECT 'legacy-live' WHERE EXISTS (SELECT 1 FROM candidate_tracks));
UPDATE refresh_state SET candidate_count = (
  SELECT COUNT(*) FROM recordings r
  WHERE r.generation = 'legacy-live'
    AND NOT EXISTS (SELECT 1 FROM never_recordings n WHERE n.recording_key = r.recording_key)
) WHERE singleton = 1;
