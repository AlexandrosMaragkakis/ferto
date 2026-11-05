-- Existing in-flight generations used the broad appears_on/compilation crawl.
-- New inserts default to v2. Rows present when this migration runs are restarted.
ALTER TABLE refresh_jobs ADD COLUMN algorithm_version INTEGER NOT NULL DEFAULT 2;
UPDATE refresh_jobs SET algorithm_version = 1;
