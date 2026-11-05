CREATE TABLE IF NOT EXISTS refresh_jobs (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation TEXT NOT NULL,
  phase TEXT NOT NULL,
  cursor TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_known_tracks (
  generation TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  PRIMARY KEY (generation, spotify_id)
);
CREATE TABLE IF NOT EXISTS refresh_liked_artists (
  generation TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  cursor TEXT,
  PRIMARY KEY (generation, spotify_id)
);
CREATE TABLE IF NOT EXISTS refresh_playlist_queue (
  generation TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  cursor TEXT,
  PRIMARY KEY (generation, spotify_id)
);
CREATE TABLE IF NOT EXISTS refresh_album_queue (
  generation TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  album_name TEXT NOT NULL,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  cursor TEXT,
  PRIMARY KEY (generation, spotify_id)
);
