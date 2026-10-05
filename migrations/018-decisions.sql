-- Jev typed decisions (#29): a Business's live permission to send Customer messages to Jev for workflow decisions.
-- Only real pairs exist: DeepSeek and Qwen generate and extract, Jev only decides.
ALTER TABLE provider_permissions DROP CONSTRAINT provider_permissions_provider_check,
  DROP CONSTRAINT provider_permissions_operation_check,
  ADD CONSTRAINT provider_permissions_pair_check CHECK((provider IN ('deepseek','qwen') AND operation IN ('generation','extraction'))
    OR (provider='jev' AND operation='decision'));
-- Decision attempts are recorded like other provider attempts: value-free, with the served model, usage and cost estimate.
ALTER TABLE execution_attempts DROP CONSTRAINT execution_attempts_operation_check,
  ADD CONSTRAINT execution_attempts_operation_check CHECK(operation IN ('generation','extraction','decision'));
