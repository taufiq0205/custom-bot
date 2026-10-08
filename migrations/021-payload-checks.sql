-- Value-free pre-send attestation that a provider payload was checked for the Business's active credentials and the worker's provider keys.
ALTER TABLE execution_attempts ADD COLUMN payload_check jsonb;
