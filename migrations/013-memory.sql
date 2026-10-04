-- Consent and revisions are value-free barriers against late extraction and renewed-consent history mining.
CREATE TABLE memory_consents (
 business_id uuid NOT NULL, customer_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT false,
 epoch bigint NOT NULL DEFAULT 0, revision bigint NOT NULL DEFAULT 1, disclosure_version text,
 eligible_conversation uuid, source_floor bigint NOT NULL DEFAULT 0,
 opted_in_at timestamptz, disabled_at timestamptz,
 PRIMARY KEY(business_id,customer_id),
 FOREIGN KEY(business_id,customer_id) REFERENCES customers(business_id,id),
 FOREIGN KEY(business_id,eligible_conversation) REFERENCES conversations(business_id,id)
);
CREATE TABLE customer_memories (
 business_id uuid NOT NULL, customer_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('preferred_name','language','communication_style','product_interests')),
 value text NOT NULL CHECK(length(value) BETWEEN 1 AND 120), source_message uuid,
 provenance text NOT NULL CHECK(provenance IN ('extraction','customer-correction','operator-correction')),
 corrected_by text, confirmed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 revision bigint NOT NULL, consent_epoch bigint NOT NULL,
 PRIMARY KEY(business_id,customer_id,kind),
 FOREIGN KEY(business_id,customer_id) REFERENCES memory_consents(business_id,customer_id),
 FOREIGN KEY(business_id,source_message) REFERENCES messages(business_id,id) ON DELETE CASCADE
);
-- Separate durable post-turn jobs: extraction never changes the completed turn's outcome or replays after a crash.
CREATE TABLE memory_extractions (
 job_id uuid PRIMARY KEY, business_id uuid NOT NULL, customer_id uuid NOT NULL,
 epoch bigint NOT NULL, revision bigint NOT NULL, execution_generation bigint NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','discarded')),
 error text, lease_expires_at timestamptz,
 FOREIGN KEY(business_id,job_id) REFERENCES jobs(business_id,id),
 FOREIGN KEY(business_id,customer_id) REFERENCES memory_consents(business_id,customer_id)
);
CREATE INDEX memory_extractions_pending ON memory_extractions(job_id) WHERE status IN ('queued','running');
