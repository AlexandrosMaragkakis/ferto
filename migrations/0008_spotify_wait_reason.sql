-- Spotify distinguishes short rolling rate limits from Development Mode's
-- shared quota. Persist the distinction so the UI can explain long waits.
ALTER TABLE refresh_jobs ADD COLUMN wait_reason TEXT CHECK (wait_reason IN ('rate_limit', 'quota'));
