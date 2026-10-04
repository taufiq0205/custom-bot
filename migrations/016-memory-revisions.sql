-- Automatic preference updates change the display revision, but cannot invalidate an otherwise authorized service turn.
ALTER TABLE memory_consents ADD COLUMN control_revision bigint NOT NULL DEFAULT 1;
UPDATE memory_consents SET control_revision=revision;
ALTER TABLE memory_extractions RENAME COLUMN revision TO control_revision;
CREATE FUNCTION memory_control_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.enabled,NEW.epoch,NEW.source_floor) IS DISTINCT FROM (OLD.enabled,OLD.epoch,OLD.source_floor) THEN
  NEW.control_revision:=OLD.control_revision+1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER memory_consents_control_revision BEFORE UPDATE ON memory_consents FOR EACH ROW EXECUTE FUNCTION memory_control_revision();
