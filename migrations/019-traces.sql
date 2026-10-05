-- Owner preview conversations (#27): pinned and executed like any other conversation, but never in the support inbox.
ALTER TABLE conversations ADD COLUMN preview boolean NOT NULL DEFAULT false;
-- Every workflow step a turn ran, in order: recorded when it starts and again when it ends, like execution attempts.
-- Value-free: route, timing and safe references only (evidence source/document/page, field names, decision choice and probability);
-- never prompts, messages, passage text, context or result values, inputs or secrets. Delivery is the job's outcome, not a step's.
CREATE TABLE execution_steps (
  id bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  job_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>0),
  step_id text NOT NULL,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','succeeded','failed')),
  output text,
  error text,
  detail jsonb,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE(job_id,ordinal),
  FOREIGN KEY(business_id,job_id) REFERENCES jobs(business_id,id)
);
-- The step visit an attempt belongs to; null for extraction attempts and for turns run before this migration.
ALTER TABLE execution_attempts ADD COLUMN step_ordinal integer;
