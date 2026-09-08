-- 0010_rag_config_and_contextual.sql
--
-- Two additions that make the RAG pipeline (a) fully configurable from the
-- dashboard and (b) "contextual-retrieval"-capable (Anthropic's technique:
-- prepend a short, model-generated blurb that situates each chunk in its parent
-- document before it is embedded and full-text indexed — ~49% fewer failed
-- retrievals, ~67% when combined with reranking).
--
-- 1. app_settings  — one org-scoped JSON blob of tunable pipeline settings, so
--                    the Settings page can change retrieval/feature/generation
--                    knobs without a redeploy (mirrors how prompts already live
--                    in the DB). RLS-isolated by org.
-- 2. chunks.context — the generated situating context for a chunk. The full-text
--                    index (fts) is rebuilt to cover context + content so BM25/
--                    keyword search benefits too; the semantic embedding is built
--                    over context+content in the ingest code. `content` stays the
--                    RAW chunk text, so citations/snippets remain clean.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. app_settings — org-scoped tunable pipeline configuration
-- ---------------------------------------------------------------------------
create table if not exists app_settings (
  org_id     uuid primary key,
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table app_settings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'app_settings' and policyname = 'org_isolation_app_settings'
  ) then
    create policy org_isolation_app_settings on app_settings
      using (org_id = (auth.jwt() ->> 'org_id')::uuid)
      with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. chunks.context + FTS covering context + content
-- ---------------------------------------------------------------------------
alter table chunks add column if not exists context text;

-- Rebuild the generated fts column to index the situating context alongside the
-- raw content. Dropping the column also drops its dependent GIN index, so we
-- recreate that afterwards. (No-op cost on an empty/small table; on a populated
-- table Postgres recomputes the stored tsvector once.)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'chunks' and column_name = 'fts'
  ) then
    execute 'alter table chunks drop column fts';
  end if;
end $$;

alter table chunks
  add column fts tsvector
  generated always as (
    to_tsvector('english', coalesce(context, '') || ' ' || content)
  ) stored;

create index if not exists chunks_fts_idx on chunks using gin(fts);

-- Prompts: make sure updated_at exists so the Prompt Studio can show freshness.
alter table prompts add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- 3. usage_events — record grounding outcome so Analytics can track answer
--    faithfulness and fabricated-citation rate over time.
-- ---------------------------------------------------------------------------
alter table usage_events add column if not exists grounded boolean;
alter table usage_events add column if not exists fabricated_citations int;
