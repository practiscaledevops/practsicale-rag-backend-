-- 0006_data_sources.sql : registry of ingest sources + an audit of every run.
--
-- The Brain PULLS from GET endpoints the source systems expose (e.g. call-scoring).
-- Uploads and push-webhooks are also modelled here so everything ingested has a
-- provenance row.

create table if not exists data_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  slug text,
  source_type text not null check (source_type in ('transcript','call_score','coaching','document')),
  kind text not null default 'pull_http' check (kind in ('pull_http','upload','push_webhook')),

  -- Pull configuration (kind = 'pull_http')
  endpoint_url text,
  http_method text not null default 'GET',
  auth_type text not null default 'none' check (auth_type in ('none','bearer','api_key','basic')),
  -- Store only a REFERENCE to where the secret lives (env var name / vault key),
  -- never the secret itself in a normal column.
  auth_secret_ref text,
  headers jsonb not null default '{}',
  query_params jsonb not null default '{}',
  -- JSON path to the array of records in the response, and the record id field.
  records_path text,
  record_id_field text,

  -- Incremental sync: pull only rows newer than the cursor.
  cursor_field text,                 -- field in the source record used as the watermark
  cursor_value text,                 -- last seen value (updated after each successful run)
  schedule_cron text,                -- optional cron; null = manual/webhook only

  is_active boolean not null default true,
  last_run_at timestamptz,
  last_status text,                  -- 'success' | 'error' | null
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, slug)
);
create index if not exists data_sources_org_idx on data_sources(org_id);
create index if not exists data_sources_type_idx on data_sources(source_type);

-- One row per ingest attempt (manual, scheduled, webhook, or upload).
create table if not exists ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  trigger text not null check (trigger in ('manual','schedule','webhook','upload')),
  status text not null default 'running' check (status in ('running','success','error')),
  documents_ingested int not null default 0,
  chunks_ingested int not null default 0,
  documents_skipped int not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists ingestion_runs_org_idx on ingestion_runs(org_id);
create index if not exists ingestion_runs_source_idx on ingestion_runs(data_source_id);

alter table data_sources enable row level security;
alter table ingestion_runs enable row level security;

create policy org_isolation_data_sources on data_sources
  for all
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);

create policy org_isolation_ingestion_runs on ingestion_runs
  for all
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
