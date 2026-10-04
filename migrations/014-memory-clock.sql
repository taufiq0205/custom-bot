-- Only test-mode callers enable this clock. Production always uses real UTC time, even if the test table contains rows.
CREATE TABLE test_memory_clock(business_id uuid PRIMARY KEY REFERENCES businesses(id), shift interval NOT NULL);
CREATE FUNCTION memory_now(business uuid, testing boolean) RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
 SELECT clock_timestamp()+CASE WHEN testing THEN coalesce((SELECT shift FROM test_memory_clock WHERE business_id=business),interval '0') ELSE interval '0' END $$;
