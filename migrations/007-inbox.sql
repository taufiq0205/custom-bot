-- Human takeover: one assignee per human-controlled or resolved conversation, Operator replies, manual availability.
ALTER TABLE memberships ADD COLUMN available boolean NOT NULL DEFAULT false;
ALTER TABLE conversations
  ADD COLUMN assignee_id text,
  ADD COLUMN handoff_reason text CHECK(handoff_reason IN ('customer-request','operator-takeover','automation-failure')),
  ADD FOREIGN KEY(business_id,assignee_id) REFERENCES memberships(business_id,operator_id),
  ADD CHECK((assignee_id IS NOT NULL)=(control_state IN ('human-controlled','resolved')));
-- 'human': a Customer message left for support; it never starts an automated turn.
ALTER TABLE messages
  DROP CONSTRAINT messages_author_check, ADD CONSTRAINT messages_author_check CHECK(author IN ('customer','operator','assistant','system')),
  DROP CONSTRAINT messages_turn_state_check, ADD CONSTRAINT messages_turn_state_check CHECK(turn_state IN ('queued','running','completed','failed','human')),
  ADD COLUMN operator_id text,
  ADD FOREIGN KEY(business_id,operator_id) REFERENCES memberships(business_id,operator_id),
  DROP CONSTRAINT messages_check,
  ADD CONSTRAINT messages_check CHECK((author='customer')=(turn_state IS NOT NULL) AND (author IN ('customer','operator'))=(client_submission_id IS NOT NULL)
    AND (author='operator')=(operator_id IS NOT NULL));
-- Every control change, from any writer (app, worker, Membership revocation), takes effect in the same transaction:
-- a new execution generation rejects late automated results, pending automated turns stop, and the Customer sees the new status.
CREATE FUNCTION advance_control() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.control_state IS DISTINCT FROM OLD.control_state THEN
    NEW.execution_generation := OLD.execution_generation+1;
    NEW.last_message_at := clock_timestamp();
  END IF;
  IF NEW.control_state IS DISTINCT FROM OLD.control_state OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN
    NEW.revision := OLD.revision+1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversations_control_advance BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION advance_control();
CREATE FUNCTION announce_control() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.control_state<>'automated' THEN
    UPDATE jobs SET status='failed', lease_owner=NULL, error='paused for human support' WHERE conversation_id=NEW.id AND status IN ('queued','running');
    UPDATE messages SET turn_state='human' WHERE conversation_id=NEW.id AND turn_state IN ('queued','running');
  END IF;
  -- No response-time promise: nobody may be available.
  INSERT INTO messages(id,business_id,conversation_id,author,text) VALUES(gen_random_uuid(),NEW.business_id,NEW.id,'system',CASE NEW.control_state
    WHEN 'waiting-for-support' THEN 'Waiting for support. Automated replies are paused; a member of our support team will reply in this chat.'
    WHEN 'human-controlled' THEN 'Support joined.'
    WHEN 'automated' THEN 'Automated assistant resumed.'
    ELSE 'Conversation resolved. Send a message here if you need more help.' END);
  RETURN NULL;
END $$;
CREATE TRIGGER conversations_control_announce AFTER UPDATE OF control_state ON conversations
  FOR EACH ROW WHEN (NEW.control_state IS DISTINCT FROM OLD.control_state) EXECUTE FUNCTION announce_control();
-- A revoked Member keeps no sending authority, whoever revokes: their human-controlled conversations return to the shared queue.
CREATE FUNCTION release_revoked_assignments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversations SET control_state='waiting-for-support',assignee_id=NULL
    WHERE business_id=NEW.business_id AND assignee_id=NEW.operator_id AND control_state='human-controlled';
  RETURN NULL;
END $$;
CREATE TRIGGER memberships_release_assignments AFTER UPDATE OF active ON memberships
  FOR EACH ROW WHEN (OLD.active AND NOT NEW.active) EXECUTE FUNCTION release_revoked_assignments();
