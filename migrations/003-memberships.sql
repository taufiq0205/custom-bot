CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  email text NOT NULL CHECK(length(email) BETWEEN 3 AND 254 AND email=lower(email)),
  role text NOT NULL CHECK(role IN ('Owner','Support')),
  token_verifier text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  inviter_id text NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,inviter_id) REFERENCES memberships(business_id,operator_id)
);
-- Serialize every Membership write for a Business, including writes outside the API.
CREATE FUNCTION protect_last_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.business_id<>OLD.business_id OR NEW.operator_id<>OLD.operator_id) THEN
    RAISE EXCEPTION 'Membership identity cannot change' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM businesses WHERE id=NEW.business_id FOR UPDATE;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM businesses WHERE id=OLD.business_id FOR UPDATE;
  IF OLD.active AND OLD.role='Owner' AND
     (TG_OP='DELETE' OR NOT NEW.active OR NEW.role<>'Owner') AND
     NOT EXISTS(SELECT 1 FROM memberships WHERE business_id=OLD.business_id
       AND operator_id<>OLD.operator_id AND active AND role='Owner') THEN
    RAISE EXCEPTION 'Keep at least one active Owner' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_owner_guard BEFORE INSERT OR UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION protect_last_owner();
