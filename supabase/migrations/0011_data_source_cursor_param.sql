-- 0011_data_source_cursor_param.sql
--
-- Some pull endpoints name their "only newer than" filter differently from the
-- record's watermark field. The call-scoring API, for example, filters with a
-- `since=<ISO>` query param but each record's timestamp lives in `created_at`.
--
-- `cursor_param` decouples the two:
--   • cursor_field — the record field the runner reads to advance the watermark
--   • cursor_param — the query-param NAME to send that watermark under
-- When cursor_param is null the runner falls back to cursor_field for the param
-- name (backwards-compatible with existing sources).
--
-- Idempotent.

alter table data_sources add column if not exists cursor_param text;
