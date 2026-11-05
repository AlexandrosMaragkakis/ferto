-- 0014 rerouted every active rebuild through Never identity resolution. A job
-- that had not yet completed preflight has no verified owner_user_id and must
-- not bypass the account/scope gate. Correct the phase based on that durable
-- proof, invalidate old Queue revisions again, and leave post-preflight jobs on
-- the intended Never-identity path.
UPDATE rebuild_jobs
SET phase = CASE
      WHEN owner_user_id IS NULL OR owner_user_id = '' THEN 'preflight'
      ELSE 'never_identities'
    END,
    cursor = NULL,
    work_key = NULL,
    lease_until = NULL,
    retry_at = NULL,
    retry_count = 0,
    next_read_at = 0,
    revision = revision + 1,
    dispatch_pending = 1,
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE singleton = 1 AND status = 'active';
