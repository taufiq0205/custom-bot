-- Live Owner permission to transfer Customer data to a cloud provider, per Business, provider and operation.
-- Like action controls, it overrides published versions: the worker checks it before every attempt, before accepting
-- a result and before delivering a reply. Any change bumps the revision, so an in-flight result under the old one is discarded.
-- Extraction is recorded now; its use arrives with Customer memory (#23).
CREATE TABLE provider_permissions (
  business_id uuid NOT NULL REFERENCES businesses(id),
  provider text NOT NULL CHECK(provider IN ('deepseek','qwen')),
  operation text NOT NULL CHECK(operation IN ('generation','extraction')),
  allowed boolean NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(business_id,provider,operation)
);
-- Value-free provider measurements: operation, whether the attempt was the fallback, the model the provider reports serving,
-- token usage and the cost estimate at operator-configured rates (null without rates).
ALTER TABLE execution_attempts ADD COLUMN operation text CHECK(operation IN ('generation','extraction')),
  ADD COLUMN fallback boolean NOT NULL DEFAULT false, ADD COLUMN served_model text,
  ADD COLUMN prompt_tokens integer, ADD COLUMN completion_tokens integer, ADD COLUMN cost_usd numeric;
-- The worker reports provider key presence and endpoints (never key values) for readiness.
ALTER TABLE worker_health ADD COLUMN generation jsonb;
