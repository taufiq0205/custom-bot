-- Public ES256 keys a Business website signs Customer identity assertions with; private keys never reach the platform.
CREATE TABLE customer_signing_keys (
  business_id uuid NOT NULL REFERENCES businesses(id),
  kid text NOT NULL CHECK(kid ~ '^[A-Za-z0-9._-]{1,100}$'),
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 200),
  public_jwk jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(business_id,kid)
);
-- A Customer is the Business plus its website's stable subject; nothing else (email, phone) identifies or merges them.
CREATE TABLE customers (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(business_id,external_id),
  UNIQUE(business_id,id)
);
-- Accepted assertion IDs; a replayed assertion cannot reopen a Customer's history.
-- ponytail: rows are kept after expiry; prune expired ones with the retention work (#24).
CREATE TABLE customer_assertions (
  business_id uuid NOT NULL REFERENCES businesses(id),
  jti text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(business_id,jti)
);
-- A session is anonymous, or verified as one Customer until its assertion expires; logout/switch ends it.
ALTER TABLE chat_sessions
  ADD COLUMN customer_id uuid,
  ADD COLUMN signing_kid text,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN ended_at timestamptz,
  ADD FOREIGN KEY(business_id,customer_id) REFERENCES customers(business_id,id),
  ADD CHECK((customer_id IS NULL)=(expires_at IS NULL) AND (customer_id IS NULL)=(signing_kid IS NULL));
ALTER TABLE conversations
  ADD COLUMN customer_id uuid,
  ADD FOREIGN KEY(business_id,customer_id) REFERENCES customers(business_id,id);
CREATE INDEX conversations_customer ON conversations(business_id,customer_id) WHERE customer_id IS NOT NULL;
CREATE FUNCTION protect_conversation_customer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'Conversation Customer cannot change' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversations_customer_guard BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION protect_conversation_customer();
-- The session that submitted a Customer message; its validity is rechecked before work starts and before results are accepted.
ALTER TABLE messages ADD COLUMN session_id uuid REFERENCES chat_sessions(id);
UPDATE messages m SET session_id=c.session_id FROM conversations c WHERE c.id=m.conversation_id AND m.author='customer';
ALTER TABLE messages ADD CHECK((author='customer')=(session_id IS NOT NULL));
