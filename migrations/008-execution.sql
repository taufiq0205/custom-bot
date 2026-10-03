-- A published workflow's handoff step is a deliberate route to support, distinct from an automation failure.
ALTER TABLE conversations DROP CONSTRAINT conversations_handoff_reason_check,
  ADD CONSTRAINT conversations_handoff_reason_check CHECK(handoff_reason IN ('customer-request','operator-takeover','automation-failure','workflow-handoff'));
-- Every external attempt of a turn (provider or business HTTP, including retries), recorded before it starts.
-- Value-free: no prompts, inputs, results or secrets; the redacted Owner trace view arrives with #27.
ALTER TABLE jobs ADD UNIQUE(business_id,id);
CREATE TABLE execution_attempts (
  id bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  job_id uuid NOT NULL,
  step_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('provider','http')),
  target text NOT NULL,
  status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','succeeded','failed')),
  error text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  FOREIGN KEY(business_id,job_id) REFERENCES jobs(business_id,id)
);
CREATE INDEX execution_attempts_job ON execution_attempts(job_id);
