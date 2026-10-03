-- New Businesses start from a complete, publishable simulation configuration (existing version 1 rows stay immutable).
CREATE OR REPLACE FUNCTION starting_configuration() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"schema_version":1,"generation":{"mode":"simulation"},"agents":[{"id":"assistant","name":"Simulated assistant","instructions":"Reply with a labelled simulation notice only."}],"actions":[],"workflow":{"entry":"reply","steps":[{"id":"reply","type":"agent","agent":"assistant","final":true,"position":{"x":0,"y":0}},{"id":"support","type":"handoff","position":{"x":320,"y":0}}],"connections":[{"from":"reply","output":"unsupported","to":"support"}]}}'::jsonb
$$;
-- One shared draft per Business. Raw text keeps invalid edits verbatim; it is never executed or published unvalidated.
CREATE TABLE configuration_drafts (
  business_id uuid PRIMARY KEY REFERENCES businesses(id),
  text text NOT NULL CHECK(length(text)<=262144),
  last_valid jsonb,
  revision bigint NOT NULL DEFAULT 1,
  base_version integer NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(business_id,base_version) REFERENCES published_configurations(business_id,version)
);
CREATE OR REPLACE FUNCTION seed_starting_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO published_configurations(business_id,version,document) VALUES(NEW.id,1,starting_configuration());
  INSERT INTO configuration_drafts(business_id,text,last_valid,base_version) VALUES(NEW.id,jsonb_pretty(starting_configuration()),starting_configuration(),1);
  RETURN NEW;
END $$;
INSERT INTO configuration_drafts(business_id,text,last_valid,base_version)
  SELECT p.business_id,jsonb_pretty(p.document),p.document,p.version FROM published_configurations p
  WHERE p.version=(SELECT max(version) FROM published_configurations WHERE business_id=p.business_id);
