-- A control transition creates a value-free source boundary: resume cannot retrospectively mine pre-takeover or human messages.
CREATE FUNCTION pause_memory_extraction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.execution_generation IS DISTINCT FROM OLD.execution_generation AND NEW.customer_id IS NOT NULL THEN
  UPDATE memory_consents SET revision=revision+1,source_floor=(SELECT coalesce(max(seq),0)+1 FROM messages)
   WHERE business_id=NEW.business_id AND customer_id=NEW.customer_id;
  UPDATE memory_extractions SET status='discarded',error='conversation control changed'
   WHERE business_id=NEW.business_id AND customer_id=NEW.customer_id AND status IN ('queued','running');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER conversations_memory_control AFTER UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION pause_memory_extraction();
