CREATE TABLE refresh_history (
  generation TEXT PRIMARY KEY, base_generation TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'active', progress_json TEXT NOT NULL DEFAULT '{}',
  request_counts_json TEXT NOT NULL DEFAULT '{}', error TEXT,
  db_queries INTEGER NOT NULL DEFAULT 0, rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX refresh_history_started ON refresh_history(started_at DESC);
CREATE TABLE operational_activity (
  hour INTEGER NOT NULL, scope TEXT NOT NULL, generation TEXT NOT NULL DEFAULT '',
  requests_json TEXT NOT NULL DEFAULT '{}', queries INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0,
  observations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(hour, scope, generation)
);
CREATE TABLE quota_interruptions (
  generation TEXT NOT NULL, revision INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
  endpoint TEXT, reason TEXT NOT NULL, retry_at INTEGER NOT NULL, retry_source TEXT NOT NULL,
  PRIMARY KEY(generation, revision)
);
CREATE INDEX quota_interruptions_time ON quota_interruptions(occurred_at DESC);
INSERT OR IGNORE INTO refresh_history(generation, base_generation, started_at, progress_json, request_counts_json)
  SELECT generation,
    (SELECT CASE WHEN live_generation <> rebuild_jobs.generation THEN live_generation END FROM refresh_state WHERE singleton=1),
    started_at, progress_json, request_counts_json FROM rebuild_jobs;
