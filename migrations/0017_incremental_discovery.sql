-- Additive: retain the in-flight generation and all existing work cursors.
ALTER TABLE rebuild_jobs ADD COLUMN pace_multiplier REAL NOT NULL DEFAULT 1;
ALTER TABLE rebuild_jobs ADD COLUMN pace_successes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rebuild_playlist_queue ADD COLUMN snapshot_id TEXT;
ALTER TABLE rebuild_playlist_queue ADD COLUMN cache_context TEXT;

CREATE TABLE service_token_cache (
  cache_key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Exact ids are skippable only after a canonical known recording is confirmed.
CREATE TABLE rebuild_known_tracks (
  generation TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  recording_key TEXT NOT NULL,
  PRIMARY KEY (generation, spotify_id, recording_key)
);

-- Preserve the exact-id knowledge collected before this additive upgrade.
INSERT OR IGNORE INTO rebuild_known_tracks (generation, spotify_id, recording_key)
SELECT generation, substr(recording_key, 9), recording_key FROM rebuild_known_recordings
WHERE recording_key LIKE 'spotify:%' AND length(recording_key) = 30;

-- The manifest is published only after a complete, version-verified scan.
CREATE TABLE playlist_snapshots (
  context TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (context, spotify_id)
);
CREATE TABLE playlist_snapshot_pages (
  context TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  tracks_json TEXT NOT NULL,
  PRIMARY KEY (context, spotify_id, snapshot_id, page_key)
);

-- Discovery ids have separate freshness from market playability metadata.
CREATE TABLE album_track_pages (
  context TEXT NOT NULL,
  album_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  track_ids_json TEXT NOT NULL,
  next_cursor TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (context, album_id, cursor)
);
CREATE INDEX album_track_pages_expiry ON album_track_pages(expires_at);
