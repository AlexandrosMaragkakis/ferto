-- A generation is filled before the live shelf changes. Failed refreshes therefore
-- leave the previous recommendation pool visible.
CREATE TABLE IF NOT EXISTS refresh_staging_tracks (
  generation TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  title TEXT NOT NULL,
  album_name TEXT NOT NULL,
  image_url TEXT,
  spotify_url TEXT NOT NULL,
  preview_url TEXT,
  PRIMARY KEY (generation, spotify_id)
);
