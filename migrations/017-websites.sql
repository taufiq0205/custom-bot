-- Website sources: an Owner approves one HTTPS URL scope; each refresh crawls it into a complete candidate version.
-- A source is a document or a website for life. next_refresh_at drives the daily refresh.
ALTER TABLE knowledge_sources ADD COLUMN kind text NOT NULL DEFAULT 'document' CHECK(kind IN ('document','website')),
  ADD COLUMN next_refresh_at timestamptz, ADD CHECK((kind='website')=(next_refresh_at IS NOT NULL));
-- A website version's document is its scope URL; required lists further pages that must be fetched. pages counts the snapshot.
ALTER TABLE source_versions DROP CONSTRAINT source_versions_format_check,
  ADD CONSTRAINT source_versions_format_check CHECK(format IN ('pdf','docx','txt','md','website')),
  ADD COLUMN required text[], ADD COLUMN pages integer;
-- A website passage cites the page it came from.
ALTER TABLE source_chunks ADD COLUMN url text;
-- Freshness, the refresh schedule and activation times use memory_now(), the Business clock that tests shift (014-memory-clock.sql).
