-- Queue-driven refresh scheduling. D1 remains the source of truth so Queue's
-- at-least-once delivery can safely recover from duplicate or lost wake-ups.
ALTER TABLE refresh_jobs ADD COLUMN resume_phase TEXT;
ALTER TABLE refresh_jobs ADD COLUMN artist_batch_target INTEGER;
ALTER TABLE refresh_jobs ADD COLUMN retry_at INTEGER;
ALTER TABLE refresh_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refresh_jobs ADD COLUMN dispatch_pending INTEGER NOT NULL DEFAULT 0;
