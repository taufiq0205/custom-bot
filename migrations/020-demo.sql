-- The worker reports the bundled portfolio demo service when it is enabled, so readiness can label it.
ALTER TABLE worker_health ADD COLUMN demo text;
