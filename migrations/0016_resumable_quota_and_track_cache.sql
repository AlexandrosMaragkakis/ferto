-- Additive upgrade: existing jobs, cursors, staging, and live slots stay intact.
ALTER TABLE rebuild_jobs ADD COLUMN wait_reason TEXT
  CHECK (wait_reason IN ('rate_limit', 'quota', 'upstream'));

-- Requested ids matter: Spotify may return a different market-playable id.
-- Never share a cached playability decision across owners or markets.
CREATE TABLE spotify_track_cache (
  owner_account_id TEXT NOT NULL,
  market TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  track_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner_account_id, market, spotify_id)
);
CREATE INDEX spotify_track_cache_expiry ON spotify_track_cache(expires_at);
