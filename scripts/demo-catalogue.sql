-- Deterministic public demo shelf. This file is applied only to
-- .wrangler/demo-state by the npm demo scripts; never point it at remote D1.

-- Reset every v4 table that can change which public recordings are visible.
DELETE FROM owner_sessions;
DELETE FROM oauth_states;
DELETE FROM never_recordings;
DELETE FROM never_identity_checks;
DELETE FROM rebuild_seed_artists;
DELETE FROM rebuild_album_queue;
DELETE FROM rebuild_enrich_queue;
DELETE FROM rebuild_playlist_queue;
DELETE FROM rebuild_known_recordings;
DELETE FROM rebuild_jobs;
DELETE FROM recommendation_pool_appends;
DELETE FROM recommendation_pool_removals;
DELETE FROM recommendation_slots;
DELETE FROM recommendation_buckets;
DELETE FROM recordings;
DELETE FROM recording_generations;

INSERT INTO recording_generations (generation, promoted_at)
VALUES ('demo-live', 1704067200000);

INSERT INTO recordings (
  generation,
  recording_key,
  spotify_id,
  isrc,
  title,
  album_name,
  release_date,
  image_url,
  spotify_url,
  artists_json,
  bucket_artist_id
) VALUES
  (
    'demo-live',
    'isrc:GBARL9300135',
    '4uLU6hMCjMI75M1A2tKUQC',
    'GBARL9300135',
    'Never Gonna Give You Up',
    'Whenever You Need Somebody',
    '1987-11-12',
    'https://i.scdn.co/image/ab67616d0000b273255e131abc1410833be95673',
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    '[{"id":"0gxyHStUsqpMadRV0Di1Qt","name":"Rick Astley"}]',
    '0gxyHStUsqpMadRV0Di1Qt'
  ),
  (
    'demo-live',
    'isrc:USUG11904206',
    '0VjIjW4GlUZAMYd2vXMi3b',
    'USUG11904206',
    'Blinding Lights',
    'After Hours',
    '2020-03-20',
    'https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36',
    'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
    '[{"id":"1Xyo4u8uXC1ZmMpatF05PJ","name":"The Weeknd"}]',
    '1Xyo4u8uXC1ZmMpatF05PJ'
  ),
  (
    'demo-live',
    'isrc:GBAHS1600463',
    '7qiZfU4dY1lWllzX7mPBI3',
    'GBAHS1600463',
    'Shape of You',
    '÷ (Deluxe)',
    '2017-03-03',
    'https://i.scdn.co/image/ab67616d0000b273ba5db46f4b838ef6027e6f96',
    'https://open.spotify.com/track/7qiZfU4dY1lWllzX7mPBI3',
    '[{"id":"6eUKZXaKkcviH0Ku9w2n3V","name":"Ed Sheeran"}]',
    '6eUKZXaKkcviH0Ku9w2n3V'
  );

INSERT INTO recommendation_slots (generation, bucket_artist_id, track_slot, recording_key) VALUES
  ('demo-live', '0gxyHStUsqpMadRV0Di1Qt', 1, 'isrc:GBARL9300135'),
  ('demo-live', '1Xyo4u8uXC1ZmMpatF05PJ', 1, 'isrc:USUG11904206'),
  ('demo-live', '6eUKZXaKkcviH0Ku9w2n3V', 1, 'isrc:GBAHS1600463');

INSERT INTO recommendation_buckets (generation, bucket_slot, bucket_artist_id, track_count) VALUES
  ('demo-live', 1, '0gxyHStUsqpMadRV0Di1Qt', 1),
  ('demo-live', 2, '1Xyo4u8uXC1ZmMpatF05PJ', 1),
  ('demo-live', 3, '6eUKZXaKkcviH0Ku9w2n3V', 1);

UPDATE refresh_state
SET live_generation = 'demo-live',
    refreshed_at = 1704067200000,
    candidate_count = 3,
    live_bucket_count = 3,
    last_error = NULL,
    pending_low = 0,
    last_outcome = 'promoted',
    last_outcome_at = 1704067200000,
    next_refresh_at = NULL,
    warnings_json = '{}'
WHERE singleton = 1;
