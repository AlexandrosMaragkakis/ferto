-- Spotify's immutable account_id is the owner authentication identity. Existing
-- sessions stored the older mutable user id and are intentionally invalidated.
DELETE FROM owner_sessions;
ALTER TABLE owner_sessions RENAME COLUMN spotify_user_id TO spotify_account_id;

-- The mutable profile id is still needed transiently to recognize playlists
-- owned by the service-token user; it is not used for account linking.
ALTER TABLE rebuild_jobs ADD COLUMN owner_user_id TEXT;
-- An in-flight job predates account_id verification and has no trustworthy
-- playlist-owner id. Its staged rows stay private and the next start purges it.
DELETE FROM rebuild_jobs;

-- Owner actions resolve a stale card across retained generations by Spotify
-- id alone; the older (generation, spotify_id) index cannot serve that lookup.
CREATE INDEX recordings_spotify_id_global ON recordings(spotify_id);

-- Dense slots make each public recommendation O(1) D1 row reads. They are
-- rebuilt atomically at promotion and extended while a bootstrap shelf grows.
CREATE TABLE recommendation_buckets (
  generation TEXT NOT NULL,
  bucket_slot INTEGER NOT NULL,
  bucket_artist_id TEXT NOT NULL,
  track_count INTEGER NOT NULL CHECK (track_count > 0),
  PRIMARY KEY (generation, bucket_slot),
  UNIQUE (generation, bucket_artist_id)
);

CREATE TABLE recommendation_slots (
  generation TEXT NOT NULL,
  bucket_artist_id TEXT NOT NULL,
  track_slot INTEGER NOT NULL,
  recording_key TEXT NOT NULL,
  PRIMARY KEY (generation, bucket_artist_id, track_slot),
  UNIQUE (generation, recording_key),
  FOREIGN KEY (generation, recording_key) REFERENCES recordings(generation, recording_key) ON DELETE CASCADE
);

ALTER TABLE refresh_state ADD COLUMN live_bucket_count INTEGER NOT NULL DEFAULT 0;

-- Backfill the currently live shelf so this migration is safe on a running v4
-- installation; exclusions remain authoritative during the backfill.
INSERT INTO recommendation_slots (generation, bucket_artist_id, track_slot, recording_key)
SELECT r.generation,
       r.bucket_artist_id,
       ROW_NUMBER() OVER (PARTITION BY r.generation, r.bucket_artist_id ORDER BY r.recording_key),
       r.recording_key
FROM recordings r
WHERE r.generation = (SELECT live_generation FROM refresh_state WHERE singleton = 1)
  AND NOT EXISTS (SELECT 1 FROM never_recordings n WHERE n.recording_key = r.recording_key)
  AND NOT EXISTS (
    SELECT 1 FROM rebuild_known_recordings k
    WHERE k.generation = r.generation AND k.recording_key = r.recording_key
  );

INSERT INTO recommendation_buckets (generation, bucket_slot, bucket_artist_id, track_count)
SELECT generation,
       ROW_NUMBER() OVER (PARTITION BY generation ORDER BY bucket_artist_id),
       bucket_artist_id,
       track_count
FROM (
  SELECT generation, bucket_artist_id, COUNT(*) AS track_count
  FROM recommendation_slots
  GROUP BY generation, bucket_artist_id
);

UPDATE refresh_state
SET candidate_count = (
      SELECT COUNT(*) FROM recommendation_slots s
      WHERE s.generation = refresh_state.live_generation
    ),
    live_bucket_count = (
      SELECT COUNT(*) FROM recommendation_buckets b
      WHERE b.generation = refresh_state.live_generation
    )
WHERE singleton = 1;
