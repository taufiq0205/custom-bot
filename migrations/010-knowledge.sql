-- Knowledge sources: an Owner-chosen ref (the configuration's source ID) names one live source per Business.
-- Deleting a source is final; uploading the same ref again creates a new source, so delayed jobs of the deleted one can never attach to it.
CREATE TABLE knowledge_sources (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  ref text NOT NULL CHECK(ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  active_version_id uuid,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(business_id,id)
);
CREATE UNIQUE INDEX knowledge_sources_live_ref ON knowledge_sources(business_id,ref) WHERE deleted_at IS NULL;
-- One uploaded document per version. Its bytes live here (on the database volume) only while needed:
-- queued/running candidates and the active version, which a new encoding policy re-indexes. Deletion erases them in the same transaction.
CREATE TABLE source_versions (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  business_id uuid NOT NULL,
  source_id uuid NOT NULL,
  document text NOT NULL CHECK(length(document) BETWEEN 1 AND 200),
  format text NOT NULL CHECK(format IN ('pdf','docx','txt','md')),
  size integer NOT NULL,
  content bytea,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','active','superseded','failed','deleted')),
  error text,
  encoding text,
  passages integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE(business_id,id),
  FOREIGN KEY(business_id,source_id) REFERENCES knowledge_sources(business_id,id)
);
ALTER TABLE knowledge_sources ADD FOREIGN KEY(business_id,active_version_id) REFERENCES source_versions(business_id,id);
-- Passages of a complete version, inserted in the transaction that activates it. encoding names the model revision and policy;
-- only passages whose encoding matches the worker's current one are ever compared with a query.
CREATE TABLE source_chunks (
  id bigserial PRIMARY KEY,
  business_id uuid NOT NULL,
  source_id uuid NOT NULL,
  version_id uuid NOT NULL,
  ordinal integer NOT NULL,
  page integer,
  content text NOT NULL,
  embedding vector(384) NOT NULL,
  FOREIGN KEY(business_id,source_id) REFERENCES knowledge_sources(business_id,id),
  FOREIGN KEY(business_id,version_id) REFERENCES source_versions(business_id,id)
);
CREATE INDEX source_chunks_version ON source_chunks(version_id);
-- Ingestion jobs share the durable job store with turns.
ALTER TABLE jobs
  DROP CONSTRAINT jobs_kind_check, ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('turn','ingest')),
  ALTER COLUMN conversation_id DROP NOT NULL,
  ALTER COLUMN message_id DROP NOT NULL,
  ALTER COLUMN execution_generation DROP NOT NULL,
  ADD COLUMN version_id uuid,
  ADD FOREIGN KEY(business_id,version_id) REFERENCES source_versions(business_id,id),
  ADD CHECK(CASE kind WHEN 'turn' THEN conversation_id IS NOT NULL AND message_id IS NOT NULL AND execution_generation IS NOT NULL AND version_id IS NULL
    ELSE conversation_id IS NULL AND message_id IS NULL AND version_id IS NOT NULL END);
-- Delivered knowledge answers carry the platform-resolved document/page references they cite.
ALTER TABLE messages ADD COLUMN citations jsonb;
