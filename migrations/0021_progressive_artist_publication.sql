-- Additive: preserve active cursors, pacing, retry gates and the public shelf.
ALTER TABLE rebuild_seed_artists ADD COLUMN admitted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rebuild_jobs ADD COLUMN priority_new_artists INTEGER NOT NULL DEFAULT 1;
CREATE INDEX artist_working_set ON rebuild_seed_artists(generation, admitted, turns, spotify_id);
UPDATE rebuild_seed_artists SET admitted=1
WHERE generation=(SELECT generation FROM rebuild_jobs WHERE singleton=1)
  AND spotify_id=(SELECT work_key FROM rebuild_jobs WHERE singleton=1);

-- Only newly copied recordings are recorded. This keeps the original baseline
-- distinguishable from additions during final promotion and yield accounting.
CREATE TABLE refresh_publications (
  generation TEXT NOT NULL,
  live_generation TEXT NOT NULL,
  recording_key TEXT NOT NULL,
  bucket_artist_id TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY(generation, recording_key)
);
ALTER TABLE refresh_state ADD COLUMN last_publication_at INTEGER;
