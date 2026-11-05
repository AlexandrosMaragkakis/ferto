-- Additive: preserve the current generation, cursors and retry deadline.
ALTER TABLE rebuild_jobs ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE rebuild_jobs ADD COLUMN request_counts_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE rebuild_jobs ADD COLUMN progress_started_at INTEGER;
ALTER TABLE rebuild_jobs ADD COLUMN progress_partial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rebuild_jobs ADD COLUMN retry_source TEXT CHECK (retry_source IN ('spotify', 'backoff'));
ALTER TABLE rebuild_jobs ADD COLUMN quota_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rebuild_jobs ADD COLUMN quota_wait_started_at INTEGER;
ALTER TABLE rebuild_jobs ADD COLUMN quota_endpoint TEXT;
ALTER TABLE rebuild_jobs ADD COLUMN quota_last_recovery_at INTEGER;
ALTER TABLE rebuild_jobs ADD COLUMN quota_last_wait_ms INTEGER;

-- Completed work rows were deleted by older versions. Retain recoverable
-- counts once at upgrade, and explicitly mark historical totals incomplete.
UPDATE rebuild_jobs SET progress_started_at = unixepoch() * 1000, progress_partial = 1,
  quota_attempts = CASE WHEN wait_reason = 'quota' THEN 1 ELSE 0 END,
  quota_wait_started_at = CASE WHEN wait_reason = 'quota' THEN updated_at ELSE NULL END,
  quota_endpoint = CASE WHEN wait_reason = 'quota' THEN CASE
    WHEN phase IN ('enrich', 'never_identities') THEN 'tracks'
    WHEN phase IN ('seeds', 'known_liked') THEN 'likedTracks'
    WHEN phase = 'artist_albums' THEN 'artistAlbums'
    WHEN phase = 'album_tracks' THEN 'albumTracks'
    WHEN phase = 'known_playlists' THEN 'playlists'
    ELSE NULL END ELSE NULL END,
  progress_json = json_object(
    'seedArtists', (SELECT count(*) FROM rebuild_seed_artists WHERE generation = rebuild_jobs.generation),
    'seedScanComplete', CASE WHEN phase IN ('preflight', 'never_identities', 'seeds') THEN 0 ELSE 1 END,
    'tracksDiscovered', (SELECT coalesce(sum(CASE WHEN json_valid(track_ids_json) THEN json_array_length(track_ids_json) ELSE 0 END), 0) FROM rebuild_enrich_queue WHERE generation = rebuild_jobs.generation),
    'stagedRecordings', (SELECT count(*) FROM recordings WHERE generation = rebuild_jobs.generation),
    'playlists', (SELECT count(*) FROM rebuild_playlist_queue WHERE generation = rebuild_jobs.generation)
  );

-- Preserve the latest run's counters after promotion removes its work row.
ALTER TABLE refresh_state ADD COLUMN last_progress_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE refresh_state ADD COLUMN last_request_counts_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE refresh_state ADD COLUMN last_progress_started_at INTEGER;
ALTER TABLE refresh_state ADD COLUMN last_progress_partial INTEGER NOT NULL DEFAULT 0;
