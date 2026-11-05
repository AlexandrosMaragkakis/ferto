-- Preserve permanent v3 Never decisions while v4 upgrades a recording from
-- spotify:<id> identity to its canonical isrc:<ISRC> identity.
CREATE INDEX IF NOT EXISTS never_recordings_spotify_id ON never_recordings(spotify_id);

-- If an already-retained recording teaches us the ISRC for a legacy Never id,
-- add the canonical alias. Keep the original id-only row as an audit trail and
-- as protection for tracks that genuinely have no ISRC.
INSERT OR IGNORE INTO never_recordings (recording_key, isrc, spotify_id, excluded_at)
SELECT r.recording_key, r.isrc, MIN(r.spotify_id), MIN(n.excluded_at)
FROM recordings r
JOIN never_recordings n ON n.spotify_id = r.spotify_id OR n.recording_key = r.recording_key
WHERE r.isrc IS NOT NULL
GROUP BY r.recording_key, r.isrc;

-- A deployment may already have materialized a mismatched ISRC-keyed row into
-- the live dense pool. Rebuild only that retained live pool transactionally as
-- part of the migration, matching Never by canonical key or exact Spotify id.
DELETE FROM recommendation_slots
WHERE generation = (SELECT live_generation FROM refresh_state WHERE singleton = 1);

DELETE FROM recommendation_buckets
WHERE generation = (SELECT live_generation FROM refresh_state WHERE singleton = 1);

INSERT INTO recommendation_slots (generation, bucket_artist_id, track_slot, recording_key)
SELECT r.generation,
       r.bucket_artist_id,
       ROW_NUMBER() OVER (PARTITION BY r.bucket_artist_id ORDER BY r.recording_key),
       r.recording_key
FROM recordings r
WHERE r.generation = (SELECT live_generation FROM refresh_state WHERE singleton = 1)
  AND NOT EXISTS (
    SELECT 1 FROM never_recordings n
    WHERE n.recording_key = r.recording_key OR n.spotify_id = r.spotify_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM rebuild_known_recordings k
    WHERE k.generation = r.generation AND k.recording_key = r.recording_key
  );

INSERT INTO recommendation_buckets (generation, bucket_slot, bucket_artist_id, track_count)
SELECT generation,
       ROW_NUMBER() OVER (ORDER BY bucket_artist_id),
       bucket_artist_id,
       track_count
FROM (
  SELECT generation, bucket_artist_id, COUNT(*) AS track_count
  FROM recommendation_slots
  WHERE generation = (SELECT live_generation FROM refresh_state WHERE singleton = 1)
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
