-- 0016_ingestion_run_document.sql — link single-document ingestion runs to their
-- document, so the inspector can show a document's processing-run history.
-- Only set for upload / reingest runs (a pull-connector run ingests many docs and
-- leaves this null). Nullable + graceful: the app skips setting/reading it until
-- this column exists.

alter table public.ingestion_runs
  add column if not exists document_id uuid references documents(id) on delete set null;

create index if not exists ingestion_runs_document_idx
  on public.ingestion_runs (document_id, started_at desc);
