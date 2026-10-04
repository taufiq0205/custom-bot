-- Live action controls. They override published snapshots: the worker rechecks them before every attempt,
-- before accepting a result and before delivering a reply.
-- A credential is sent only to its approved origin. The secret is AES-256-GCM ciphertext whose key lives outside the database;
-- revocation erases it.
CREATE TABLE action_credentials (
  business_id uuid NOT NULL REFERENCES businesses(id),
  ref text NOT NULL CHECK(ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  origin text NOT NULL CHECK(origin ~ '^https://'),
  header text NOT NULL CHECK(header ~ '^(authorization|x-[a-z0-9-]{1,60})$'),
  ciphertext bytea,
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(business_id,ref),
  CHECK(active=(ciphertext IS NOT NULL))
);
-- Deterministic Customer authorization: the platform sends the verified Customer's ID as customer_parameter,
-- and accepts a result only when its owner_field equals that ID.
CREATE TABLE authorization_policies (
  business_id uuid NOT NULL REFERENCES businesses(id),
  ref text NOT NULL CHECK(ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  customer_parameter text NOT NULL CHECK(customer_parameter ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$'),
  owner_field text NOT NULL CHECK(owner_field ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$'),
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(business_id,ref)
);
-- A revoked action ID cannot run in any configuration version, including pinned older ones.
CREATE TABLE action_revocations (
  business_id uuid NOT NULL REFERENCES businesses(id),
  action_id text NOT NULL,
  revoked_by text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(business_id,action_id)
);
-- Completed, authorized lookups: only the declared result fields, shown to support as timestamped historical observations.
CREATE TABLE lookup_results (
  id bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  conversation_id uuid NOT NULL,
  job_id uuid NOT NULL,
  step_id text NOT NULL,
  action_id text NOT NULL,
  result jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(business_id,conversation_id) REFERENCES conversations(business_id,id),
  FOREIGN KEY(business_id,job_id) REFERENCES jobs(business_id,id)
);
CREATE INDEX lookup_results_conversation ON lookup_results(conversation_id);
