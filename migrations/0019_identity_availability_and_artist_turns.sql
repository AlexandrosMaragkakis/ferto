-- Identity is reusable; availability must be independently fresh in this market.
CREATE TABLE recording_identity_cache (
  owner_account_id TEXT NOT NULL, market TEXT NOT NULL, spotify_id TEXT NOT NULL,
  track_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner_account_id, market, spotify_id)
);
CREATE INDEX identity_cache_expiry ON recording_identity_cache(expires_at);
CREATE TABLE track_availability (
  owner_account_id TEXT NOT NULL, market TEXT NOT NULL, spotify_id TEXT NOT NULL,
  returned_id TEXT NOT NULL, availability_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner_account_id, market, spotify_id)
);
CREATE INDEX availability_expiry ON track_availability(expires_at);
CREATE TABLE album_availability_pages (
  context TEXT NOT NULL, album_id TEXT NOT NULL, cursor TEXT NOT NULL,
  expires_at INTEGER NOT NULL, PRIMARY KEY(context, album_id, cursor)
);
UPDATE spotify_track_cache SET expires_at = min(expires_at, unixepoch() * 1000 + 86400000);
UPDATE album_track_pages SET expires_at = min(expires_at, unixepoch() * 1000 + 86400000);
ALTER TABLE rebuild_seed_artists ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rebuild_jobs ADD COLUMN fair_scheduler INTEGER NOT NULL DEFAULT 1;
CREATE INDEX artist_turn_order ON rebuild_seed_artists(generation, turns, spotify_id);
