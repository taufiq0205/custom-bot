CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE businesses (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  business_id uuid NOT NULL REFERENCES businesses(id),
  operator_id text NOT NULL REFERENCES "user"(id),
  role text NOT NULL CHECK(role IN ('Owner','Support')),
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY(business_id,operator_id)
);
CREATE TABLE worker_health (id text PRIMARY KEY, heartbeat timestamptz NOT NULL);
-- Seed markers bind demo identities without modifying an existing Business.
CREATE TABLE demo_seeds (name text PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id));
