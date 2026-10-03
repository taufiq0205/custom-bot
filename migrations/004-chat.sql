-- Immutable published configurations; the highest version is current for new conversations.
CREATE TABLE published_configurations (
  business_id uuid NOT NULL REFERENCES businesses(id),
  version integer NOT NULL CHECK(version>0),
  document jsonb NOT NULL,
  published_by text,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(business_id,version)
);
CREATE FUNCTION reject_configuration_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published configurations are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER published_configurations_immutable BEFORE UPDATE OR DELETE ON published_configurations
  FOR EACH ROW EXECUTE FUNCTION reject_configuration_change();
-- Every Business, however created, starts with the same system-published simulation configuration.
CREATE FUNCTION starting_configuration() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"schema_version":1,"generation":{"mode":"simulation"},"agents":[{"id":"assistant","name":"Simulated assistant","instructions":"Reply with a labelled simulation notice only."}],"actions":[],"workflow":{"entry":"reply","steps":[{"id":"reply","type":"agent","agent":"assistant","final":true,"position":{"x":0,"y":0}}],"connections":[]}}'::jsonb
$$;
CREATE FUNCTION seed_starting_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO published_configurations(business_id,version,document) VALUES(NEW.id,1,starting_configuration());
  RETURN NEW;
END $$;
CREATE TRIGGER businesses_starting_configuration AFTER INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION seed_starting_configuration();
INSERT INTO published_configurations(business_id,version,document) SELECT id,1,starting_configuration() FROM businesses;

CREATE TABLE website_origins (
  business_id uuid NOT NULL REFERENCES businesses(id),
  origin text NOT NULL CHECK(length(origin) BETWEEN 8 AND 200),
  PRIMARY KEY(business_id,origin)
);
-- Anonymous browser sessions store only a SHA-256 verifier of their bearer token.
CREATE TABLE chat_sessions (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  token_verifier text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(business_id,id)
);
CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  session_id uuid NOT NULL,
  configuration_version integer NOT NULL,
  control_state text NOT NULL DEFAULT 'automated' CHECK(control_state IN ('automated','waiting-for-support','human-controlled','resolved')),
  revision bigint NOT NULL DEFAULT 1,
  execution_generation bigint NOT NULL DEFAULT 1,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(business_id,id),
  FOREIGN KEY(business_id,session_id) REFERENCES chat_sessions(business_id,id),
  FOREIGN KEY(business_id,configuration_version) REFERENCES published_configurations(business_id,version)
);
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  business_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  author text NOT NULL CHECK(author IN ('customer','assistant','system')),
  text text NOT NULL CHECK(length(text) BETWEEN 1 AND 4000),
  simulated boolean NOT NULL DEFAULT false,
  client_submission_id text,
  reply_to uuid REFERENCES messages(id),
  turn_state text CHECK(turn_state IN ('queued','running','completed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(business_id,id),
  UNIQUE(conversation_id,client_submission_id),
  CHECK((author='customer')=(client_submission_id IS NOT NULL AND turn_state IS NOT NULL)),
  FOREIGN KEY(business_id,conversation_id) REFERENCES conversations(business_id,id)
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('turn')),
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  execution_generation bigint NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  deadline timestamptz NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(business_id,conversation_id) REFERENCES conversations(business_id,id),
  FOREIGN KEY(business_id,message_id) REFERENCES messages(business_id,id)
);
CREATE UNIQUE INDEX jobs_one_running_per_conversation ON jobs(conversation_id) WHERE status='running';
CREATE INDEX jobs_unfinished ON jobs(created_at) WHERE status IN ('queued','running');
