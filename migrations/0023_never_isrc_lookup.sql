-- Additive and compatible with the previous Worker. All alternatives in the
-- Never predicate need an index so SQLite can use MULTI-INDEX OR instead of
-- scanning every exclusion for each staged or public recording.
CREATE INDEX IF NOT EXISTS never_recordings_isrc ON never_recordings(isrc);
