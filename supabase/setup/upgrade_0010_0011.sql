-- Brain schema upgrade: migrations 0010 + 0011.
-- Run this in the practiscale-brain-rag project's SQL editor. Idempotent.
-- Adds: app_settings (dashboard-editable pipeline config), chunks.context +
-- FTS over context+content (contextual retrieval), usage_events grounding
-- columns, prompts.updated_at, and data_sources.cursor_param.

-- 1) app_settings (org-scoped tunable pipeline config)
create table if not exists public.app_settings (
  org_id     uuid primary key,
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.app_settings enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'app_settings' and policyname = 'org_isolation_app_settings'
  ) then
    create policy org_isolation_app_settings on public.app_settings
      using (org_id = (auth.jwt() ->> 'org_id')::uuid)
      with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
  end if;
end $$;

-- 2) chunks.context + FTS covering context + content (contextual retrieval)
alter table public.chunks add column if not exists context text;
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'chunks' and column_name = 'fts'
  ) then
    execute 'alter table public.chunks drop column fts';
  end if;
end $$;
alter table public.chunks
  add column fts tsvector
  generated always as (to_tsvector('english', coalesce(context, '') || ' ' || content)) stored;
create index if not exists chunks_fts_idx on public.chunks using gin(fts);

-- 3) prompts freshness + usage grounding metrics
alter table public.prompts add column if not exists updated_at timestamptz not null default now();
alter table public.usage_events add column if not exists grounded boolean;
alter table public.usage_events add column if not exists fabricated_citations int;

-- 4) data source cursor param (0011)
alter table public.data_sources add column if not exists cursor_param text;
