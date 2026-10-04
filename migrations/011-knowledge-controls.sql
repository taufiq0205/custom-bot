-- An Owner can expire a document source: its active version stops answering at once and its passages and bytes go.
-- expired_through is the newest version sequence at expiry, so no candidate uploaded before it can activate afterwards.
ALTER TABLE knowledge_sources ADD COLUMN expired_at timestamptz, ADD COLUMN expired_through bigint;
ALTER TABLE source_versions DROP CONSTRAINT source_versions_state_check,
  ADD CONSTRAINT source_versions_state_check CHECK(state IN ('queued','running','active','superseded','failed','deleted','expired'));
-- The embedding model is optional: the worker reports whether knowledge is available, and readiness shows it.
ALTER TABLE worker_health ADD COLUMN knowledge text;
