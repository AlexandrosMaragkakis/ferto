CREATE TABLE IF NOT EXISTS candidate_artists (
  spotify_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT,
  refreshed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candidate_tracks (
  spotify_id TEXT PRIMARY KEY,
  artist_id TEXT NOT NULL REFERENCES candidate_artists(spotify_id) ON DELETE CASCADE,
  artist_name TEXT NOT NULL,
  title TEXT NOT NULL,
  album_name TEXT NOT NULL,
  image_url TEXT,
  spotify_url TEXT NOT NULL,
  preview_url TEXT,
  refreshed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS candidate_tracks_artist_id ON candidate_tracks(artist_id);

-- Permanent track exclusions are deliberately independent of refreshes.
CREATE TABLE IF NOT EXISTS never_tracks (
  spotify_id TEXT PRIMARY KEY,
  excluded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  refreshed_at INTEGER,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
INSERT OR IGNORE INTO refresh_state (singleton) VALUES (1);

CREATE TABLE IF NOT EXISTS owner_sessions (
  session_hash TEXT PRIMARY KEY,
  spotify_user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_sessions_expiry ON owner_sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
