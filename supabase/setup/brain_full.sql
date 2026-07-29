-- ============================================================================
--  BRAIN — CONSOLIDATED DATABASE SETUP  (brain_full.sql)
-- ============================================================================
--  Practiscale "Brain": RAG back-office + public API on Supabase Postgres
--  (Singapore / ap-southeast-1). This ONE file is the hardened, idempotent
--  superset of migrations 0001..0009. It creates every table, index, function,
--  RLS policy, the JWT auth hook, and tuning the live Next.js app depends on.
--
--  IT IS SAFE TO RUN MULTIPLE TIMES, on a FRESH or an EXISTING project.
--  It NEVER drops a table/column or truncates data. Everything is guarded with
--  "if not exists" / "add column if not exists" / "create or replace" /
--  catalog checks / "drop policy if exists" + "create policy".
--
--  COMPATIBILITY CONTRACT (do not break — the app calls these by exact name):
--    Tables : documents, chunks, prompts, conversations, messages, api_keys,
--             orgs, org_members, data_sources, ingestion_runs, connectors,
--             connector_grants, collections, document_collections, usage_events
--    RPCs   : hybrid_search(p_org_id, query_text, query_embedding, match_count,
--                           full_text_weight, semantic_weight, rrf_k,
--                           filter_source_type)
--             hybrid_search_scoped(p_org_id, query_text, query_embedding,
--                           p_source_types, p_data_source_ids, p_collection_ids,
--                           match_count, full_text_weight, semantic_weight, rrf_k)
--    Embedding column: chunks.embedding vector(1024)  (text-embedding-3-large/1024)
--
--  ──────────────────────────────────────────────────────────────────────────
--  HOW TO RUN
--  ──────────────────────────────────────────────────────────────────────────
--   1. Open Supabase Studio → SQL Editor → New query.
--   2. Paste this whole file and Run. (It is one self-contained script.)
--   3. It is transaction-friendly; the SQL editor may wrap it — that is fine.
--      The only things that CANNOT run inside a transaction are CREATE INDEX
--      CONCURRENTLY statements: those are provided commented-out at the bottom
--      for very large existing tables and must be run individually, at top
--      level, one at a time.
--
--  MANUAL POST-STEPS (each is documented inline where it is defined):
--   A. Enable the JWT auth hook so RLS works for dashboard users:
--        Dashboard → Authentication → Hooks → "Custom Access Token" →
--        select schema "public", function "custom_access_token_hook". (§6)
--   B. (Optional) Turn usage_events into a native monthly-partitioned table for
--      very high request volume, and schedule pg_cron maintenance. (§9)
--   C. After a large bulk ingest, run: ANALYZE public.chunks;  (keeps the HNSW
--      + FTS planner statistics fresh).
--
--  Server-side ingestion uses the service_role, which BYPASSES RLS by design.
--  RLS below is the tenant guard for authenticated dashboard users.
-- ============================================================================


-- ============================================================================
--  §1  EXTENSIONS  (installed into the dedicated "extensions" schema)
-- ============================================================================
-- On Supabase these often pre-exist in "extensions"; "if not exists" makes each
-- a no-op. If an earlier migration created vector/pg_trgm in "public", they stay
-- there (non-destructive) — the functions below put BOTH public and extensions
-- on their search_path so the vector operators resolve either way.
create schema if not exists extensions;

create extension if not exists vector              with schema extensions;  -- pgvector: embeddings + HNSW
create extension if not exists pg_trgm             with schema extensions;  -- trigram fuzzy text
create extension if not exists pgcrypto            with schema extensions;  -- gen_random_uuid(), digest()
create extension if not exists pg_stat_statements  with schema extensions;  -- query-level observability


-- ============================================================================
--  §2  TABLES  (superset of 0001..0009 — exact columns/types preserved)
-- ============================================================================
-- Creation order respects the inline FKs the original migrations declared.
-- org_id foreign keys for the 0001 core tables are added afterwards via guarded
-- DO blocks (mirrors migration 0004), so this converges from any prior state.

-- ── 2.1 orgs : the tenant root ──────────────────────────────────────────────
create table if not exists public.orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text unique,
  region     text not null default 'ap-southeast-1',
  created_at timestamptz not null default now()
);

-- ── 2.2 org_members : admins/users within an org (Supabase Auth uid link) ────
create table if not exists public.org_members (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  user_id     uuid,                       -- Supabase Auth uid (null until invited user signs in)
  email       text not null,
  role        text not null default 'admin' check (role in ('super_admin','admin')),
  permissions jsonb not null default '{}', -- granular grant set assigned by a super-admin
  is_active   boolean not null default true,
  created_by  uuid,                        -- org_member.id of the admin who created this one
  created_at  timestamptz not null default now(),
  unique (org_id, email)
);

-- ── 2.3 documents : source of truth per ingested item ───────────────────────
create table if not exists public.documents (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null,
  source_type    text not null check (source_type in ('transcript','call_score','coaching','document')),
  title          text,
  uri            text,
  content_hash   text,
  metadata       jsonb not null default '{}',
  data_source_id uuid,                      -- provenance (registered pull/push source); no FK by design
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- Converge older databases that only ran 0001:
alter table public.documents add column if not exists data_source_id uuid;

-- ── 2.4 chunks : retrievable pieces (child) with optional parent for context ─
create table if not exists public.chunks (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null,
  document_id       uuid not null references public.documents(id) on delete cascade,
  parent_id         uuid,                   -- larger parent chunk (context expansion); no FK by design
  content           text not null,
  token_count       int,
  metadata          jsonb not null default '{}',
  embedding         vector(1024),           -- text-embedding-3-large truncated to 1024 dims
  fts               tsvector generated always as (to_tsvector('english', content)) stored,
  model             text default 'text-embedding-3-large',
  embedding_version int not null default 1,
  source_type       text,                   -- denormalized from parent doc for fast scope filtering
  data_source_id    uuid,                   -- denormalized from parent doc
  collection_ids    uuid[] not null default '{}', -- denormalized collection membership
  created_at        timestamptz not null default now()
);
-- Converge older databases that only ran 0001 (columns added in 0005/0008):
alter table public.chunks add column if not exists source_type    text;
alter table public.chunks add column if not exists data_source_id uuid;
alter table public.chunks add column if not exists collection_ids uuid[] not null default '{}';

-- ── 2.5 prompts : editable, versioned system prompts (org_id NULL = global) ──
create table if not exists public.prompts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid,                           -- NULL => global/default prompt
  use_case   text not null,
  version    int not null default 1,
  content    text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- ── 2.6 conversations + messages ────────────────────────────────────────────
create table if not exists public.conversations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null,
  user_id    uuid,
  title      text,
  created_at timestamptz not null default now()
);
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  org_id          uuid not null,
  role            text not null check (role in ('user','assistant','system')),
  content         text not null,
  citations       jsonb default '[]',
  created_at      timestamptz not null default now()
);

-- ── 2.7 api_keys : scoped credentials (store only a hash + non-secret prefix) ─
create table if not exists public.api_keys (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null,
  name              text,
  key_prefix        text,                        -- non-secret, shown in UI + used for lookup
  key_hash          text not null,               -- SHA-256 of the full secret (secret shown once)
  source_types      text[]  not null default '{}',       -- {} => all source types in scope
  capabilities      text[]  not null default '{chat}',    -- subset of {chat,retrieve,generate}
  data_source_ids   uuid[]  not null default '{}',        -- {} => all sources in scope
  collection_ids    uuid[]  not null default '{}',        -- {} => all collections in scope
  rate_limit_per_min int    not null default 60,
  expires_at        timestamptz,
  revoked_at        timestamptz,
  created_by        uuid,                        -- org_member.id
  request_count     bigint  not null default 0,
  last_used_at      timestamptz,
  created_at        timestamptz not null default now()
);
-- Converge older databases that only ran 0001 (columns added in 0005):
alter table public.api_keys add column if not exists key_prefix        text;
alter table public.api_keys add column if not exists source_types      text[]  not null default '{}';
alter table public.api_keys add column if not exists capabilities      text[]  not null default '{chat}';
alter table public.api_keys add column if not exists data_source_ids   uuid[]  not null default '{}';
alter table public.api_keys add column if not exists collection_ids    uuid[]  not null default '{}';
alter table public.api_keys add column if not exists rate_limit_per_min int    not null default 60;
alter table public.api_keys add column if not exists expires_at        timestamptz;
alter table public.api_keys add column if not exists revoked_at        timestamptz;
alter table public.api_keys add column if not exists created_by        uuid;
alter table public.api_keys add column if not exists request_count     bigint  not null default 0;

-- ── 2.8 data_sources : registry of ingest sources ───────────────────────────
create table if not exists public.data_sources (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs(id) on delete cascade,
  name            text not null,
  slug            text,
  source_type     text not null check (source_type in ('transcript','call_score','coaching','document')),
  kind            text not null default 'pull_http' check (kind in ('pull_http','upload','push_webhook')),
  endpoint_url    text,
  http_method     text not null default 'GET',
  auth_type       text not null default 'none' check (auth_type in ('none','bearer','api_key','basic')),
  auth_secret_ref text,                        -- REFERENCE to secret (env var name/vault key), never the secret
  headers         jsonb not null default '{}',
  query_params    jsonb not null default '{}',
  records_path    text,                        -- JSON path to the array of records
  record_id_field text,                        -- field that identifies a record
  cursor_field    text,                        -- incremental-sync watermark field
  cursor_value    text,                        -- last-seen watermark value
  schedule_cron   text,                        -- optional cron; null = manual/webhook
  is_active       boolean not null default true,
  last_run_at     timestamptz,
  last_status     text,                        -- 'success' | 'error' | null
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, slug)
);

-- ── 2.9 ingestion_runs : one row per ingest attempt (audit/provenance) ───────
create table if not exists public.ingestion_runs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs(id) on delete cascade,
  data_source_id     uuid references public.data_sources(id) on delete set null,
  trigger            text not null check (trigger in ('manual','schedule','webhook','upload')),
  status             text not null default 'running' check (status in ('running','success','error')),
  documents_ingested int not null default 0,
  chunks_ingested    int not null default 0,
  documents_skipped  int not null default 0,
  error              text,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz
);

-- ── 2.10 connectors + connector_grants ──────────────────────────────────────
create table if not exists public.connectors (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs(id) on delete cascade,
  name            text not null,
  slug            text,
  kind            text not null check (kind in ('mcp','http_api')),
  config          jsonb not null default '{}',
  auth_secret_ref text,                        -- reference to where the secret lives, not the secret
  is_active       boolean not null default true,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  unique (org_id, slug)
);
create table if not exists public.connector_grants (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  connector_id uuid not null references public.connectors(id) on delete cascade,
  api_key_id   uuid not null references public.api_keys(id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (connector_id, api_key_id)
);

-- ── 2.11 collections + document_collections (finest-grained key scope) ───────
create table if not exists public.collections (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  name        text not null,
  slug        text,
  description text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (org_id, slug)
);
create table if not exists public.document_collections (
  org_id        uuid not null references public.orgs(id) on delete cascade,
  document_id   uuid not null references public.documents(id) on delete cascade,
  collection_id uuid not null references public.collections(id) on delete cascade,
  primary key (document_id, collection_id)
);

-- ── 2.12 usage_events : per-request metering (tokens, cost, latency) ─────────
create table if not exists public.usage_events (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  api_key_id    uuid references public.api_keys(id) on delete set null,
  user_id       uuid,
  kind          text not null check (kind in ('chat','retrieve','generate','embed')),
  model         text,
  tier          text,                          -- 'fast' | 'recommended' | 'max'
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  cost_usd      numeric(12,6) not null default 0,
  latency_ms    int,
  cached        boolean not null default false,
  created_at    timestamptz not null default now()
);


-- ============================================================================
--  §3  FOREIGN KEYS + CONSTRAINTS  (guarded so re-runs never error)
-- ============================================================================
-- 3.1 org_id FKs for the 0001 core tables (added in 0004). Guarded by conname.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'documents_org_fk') then
    alter table public.documents     add constraint documents_org_fk     foreign key (org_id) references public.orgs(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chunks_org_fk') then
    alter table public.chunks        add constraint chunks_org_fk        foreign key (org_id) references public.orgs(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'conversations_org_fk') then
    alter table public.conversations add constraint conversations_org_fk foreign key (org_id) references public.orgs(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messages_org_fk') then
    alter table public.messages      add constraint messages_org_fk      foreign key (org_id) references public.orgs(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'api_keys_org_fk') then
    alter table public.api_keys      add constraint api_keys_org_fk      foreign key (org_id) references public.orgs(id) on delete cascade;
  end if;
  -- prompts.org_id is nullable (global prompts allowed); FK still valid for non-null values.
  if not exists (select 1 from pg_constraint where conname = 'prompts_org_fk') then
    alter table public.prompts       add constraint prompts_org_fk       foreign key (org_id) references public.orgs(id) on delete cascade;
  end if;
end $$;

-- 3.2 api_keys.capabilities must be a subset of the known set (added in 0005).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_keys_capabilities_chk') then
    alter table public.api_keys add constraint api_keys_capabilities_chk
      check (capabilities <@ array['chat','retrieve','generate']::text[]);
  end if;
end $$;

-- 3.3 Ingest lookup index on (org, content_hash), partial so many rows may have a
--     NULL hash. NON-unique BY DESIGN: the app's dedup (ingestOne) is a non-atomic
--     check-then-insert, so under concurrent ingest of identical content a busy
--     project can already contain duplicate (org_id, content_hash) rows. A UNIQUE
--     index over pre-existing duplicates fails and aborts this "safe on an EXISTING
--     project" script; a unique constraint would also make concurrent identical
--     ingests throw. Drop any unique variant a previous run created. True
--     DB-enforced uniqueness must be a deliberate, separate step that first removes
--     duplicates (a data-destroying operation, not part of an always-safe script).
drop  index if exists public.documents_org_content_hash_uidx;
create index if not exists documents_org_content_hash_idx
  on public.documents (org_id, content_hash)
  where content_hash is not null;

-- 3.4 API key uniqueness. key_hash is globally unique (the secret's fingerprint).
--     key_prefix is deliberately NOT unique: keyPrefix() derives it from only the
--     first 8 hex chars of entropy and resolveContext() is built to tolerate
--     prefix collisions (it queries by key_prefix, limit 2, then constant-time
--     compares the full key_hash across candidates). A UNIQUE index on key_prefix
--     would (a) throw a unique-violation and break key creation whenever a new
--     8-char prefix collides, and (b) abort this "safe to re-run" script on an
--     existing project that already holds two keys sharing a prefix. Lookups use
--     the non-unique api_keys_prefix_idx (§4.6). Drop any unique prefix index a
--     previous run of this file may have created.
create unique index if not exists api_keys_key_hash_uidx on public.api_keys (key_hash);
drop   index        if exists     public.api_keys_key_prefix_uidx;


-- ============================================================================
--  §4  INDEXES  (FKs + hot query paths found in the app; tuned for scale)
-- ============================================================================

-- ── 4.1 Vector (HNSW) + full-text (GIN) + array (GIN) on chunks ─────────────
-- HNSW cosine index for semantic search. m=16 controls graph connectivity;
-- ef_construction=128 MATCHES ground-truth migration 0001 so a FRESH install and
-- an EXISTING database converge on the same recall (a lower value here would give
-- new projects a worse graph than the migrations under one index name). 128–200 is
-- appropriate for a mostly-static corpus. NOTE: on an EXISTING database the HNSW
-- index already exists under this name and is KEPT AS-IS (non-destructive) — to
-- rebuild with different params you must drop + recreate deliberately.
create index if not exists chunks_embedding_idx on public.chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 128);

create index if not exists chunks_fts_idx         on public.chunks using gin (fts);
create index if not exists chunks_collections_gin on public.chunks using gin (collection_ids);

-- ── 4.2 chunks btree: FKs + scope-filter composites (hybrid_search_scoped) ───
-- chunks is bulk-insert heavy, so redundant indexes directly slow ingest.
--  * chunks_org_idx (org_id) is fully subsumed by chunks_org_source_idx
--    (org_id, source_type) for both the org_id FK and org-only equality/RLS.
--  * chunks_source_type_idx (source_type) is a low-selectivity 4-value column the
--    app never filters without org_id; also subsumed by the composite.
-- Drop both (if a prior run created them) and do not recreate.
drop index if exists public.chunks_org_idx;
drop index if exists public.chunks_source_type_idx;
create index if not exists chunks_doc_idx          on public.chunks (document_id);
create index if not exists chunks_parent_idx       on public.chunks (parent_id);
create index if not exists chunks_data_source_idx  on public.chunks (data_source_id);
create index if not exists chunks_org_source_idx   on public.chunks (org_id, source_type);
create index if not exists chunks_org_dsource_idx  on public.chunks (org_id, data_source_id);

-- ── 4.3 documents: FKs + list hot path (WHERE org_id ORDER BY created_at DESC)
create index if not exists documents_org_idx          on public.documents (org_id);
create index if not exists documents_type_idx         on public.documents (source_type);
create index if not exists documents_hash_idx         on public.documents (content_hash);
create index if not exists documents_data_source_idx  on public.documents (data_source_id);
-- Documents list hot path (GET /api/admin/documents) is `where org_id = $1 order
-- by created_at desc` with NO source_type filter; the 3-column index below cannot
-- supply that ordering with source_type unconstrained in the middle, so this
-- 2-column index serves the unfiltered list directly.
create index if not exists documents_org_created_idx
  on public.documents (org_id, created_at desc);
-- Kept for future source_type-filtered lists.
create index if not exists documents_org_type_created_idx
  on public.documents (org_id, source_type, created_at desc);

-- ── 4.4 prompts: org + use_case + newest-version-first ──────────────────────
create index if not exists prompts_usecase_idx           on public.prompts (use_case);
create index if not exists prompts_org_usecase_ver_idx   on public.prompts (org_id, use_case, version desc);

-- ── 4.5 conversations / messages FKs ────────────────────────────────────────
create index if not exists conversations_org_idx on public.conversations (org_id);
create index if not exists messages_conv_idx     on public.messages (conversation_id);
create index if not exists messages_org_idx      on public.messages (org_id);

-- ── 4.6 api_keys: org list + non-secret prefix lookup ───────────────────────
create index if not exists api_keys_org_idx    on public.api_keys (org_id);
create index if not exists api_keys_prefix_idx on public.api_keys (key_prefix);

-- ── 4.7 org_members FKs ─────────────────────────────────────────────────────
create index if not exists org_members_org_idx  on public.org_members (org_id);
create index if not exists org_members_user_idx on public.org_members (user_id);

-- ── 4.8 data_sources / ingestion_runs (audit list hot path) ─────────────────
create index if not exists data_sources_org_idx     on public.data_sources (org_id);
create index if not exists data_sources_type_idx    on public.data_sources (source_type);
create index if not exists ingestion_runs_org_idx    on public.ingestion_runs (org_id);
create index if not exists ingestion_runs_source_idx on public.ingestion_runs (data_source_id);
create index if not exists ingestion_runs_org_started_idx
  on public.ingestion_runs (org_id, started_at desc);

-- ── 4.9 connectors / connector_grants FKs ───────────────────────────────────
create index if not exists connectors_org_idx           on public.connectors (org_id);
create index if not exists connector_grants_org_idx     on public.connector_grants (org_id);
create index if not exists connector_grants_conn_idx    on public.connector_grants (connector_id);
create index if not exists connector_grants_key_idx     on public.connector_grants (api_key_id);

-- ── 4.10 collections / document_collections FKs ─────────────────────────────
create index if not exists collections_org_idx                on public.collections (org_id);
create index if not exists document_collections_org_idx       on public.document_collections (org_id);
create index if not exists document_collections_collection_idx on public.document_collections (collection_id);
-- (document_id is the leading column of the composite PK -> already indexed.)

-- ── 4.11 usage_events: metering read hot path + FK ──────────────────────────
-- usage_events is the highest-insert table. A btree with the leading column
-- (org_id) equality-matched scans EITHER direction, so (org_id, created_at)
-- already serves the app's `order by created_at asc` and any desc ordering; the
-- separate desc index only added write amplification. Drop it if a prior run made
-- it, and do not recreate.
create index if not exists usage_events_org_created_idx on public.usage_events (org_id, created_at);
drop index if exists public.usage_events_org_created_desc_idx;
create index if not exists usage_events_key_idx on public.usage_events (api_key_id);


-- ============================================================================
--  §5  FUNCTIONS  (retrieval RPCs + helpers + updated_at trigger)
-- ============================================================================
-- The two search RPCs keep IDENTICAL signatures/param names/types the app calls
-- (src/lib/retrieval.ts). They are SECURITY INVOKER (default) and marked STABLE.
-- search_path is pinned to a fixed, safe set: pg_catalog is always implicit;
-- "public" resolves the chunks table; "extensions" resolves the pgvector <=>
-- operator regardless of whether pgvector lives in public or extensions.

-- ── 5.1 hybrid_search : single-source RRF of vector + full text (from 0002) ──
--     Returns SETOF chunks (all columns) — unchanged contract for the internal
--     retrieval path. filter_source_type matches metadata->>'source_type'.
create or replace function public.hybrid_search(
  p_org_id uuid,
  query_text text,
  query_embedding vector(1024),
  match_count int default 40,
  full_text_weight float default 1.0,
  semantic_weight float default 1.0,
  rrf_k int default 50,
  filter_source_type text default null
)
returns setof public.chunks
language sql
stable
set search_path = public, extensions
-- Pin the HNSW dynamic candidate list >= the semantic leg's LIMIT
-- (least(match_count,200)*2, i.e. up to 400). pgvector's default ef_search of 40
-- would silently cap the candidate list far below what RRF fusion requests.
set hnsw.ef_search = 200
as $$
  with full_text as (
    select id, row_number() over (
             order by ts_rank_cd(fts, websearch_to_tsquery('english', query_text)) desc
           ) as rank_ix
    from public.chunks
    where org_id = p_org_id
      and (filter_source_type is null or metadata->>'source_type' = filter_source_type)
      and fts @@ websearch_to_tsquery('english', query_text)
    order by rank_ix
    limit least(match_count, 200) * 2
  ),
  semantic as (
    select id, row_number() over (order by embedding <=> query_embedding) as rank_ix
    from public.chunks
    where org_id = p_org_id
      and (filter_source_type is null or metadata->>'source_type' = filter_source_type)
    order by rank_ix
    limit least(match_count, 200) * 2
  )
  select c.*
  from full_text
  full outer join semantic on full_text.id = semantic.id
  join public.chunks c on c.id = coalesce(full_text.id, semantic.id)
  order by
    coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
    coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight desc
  limit least(match_count, 200);
$$;

-- ── 5.2 hybrid_search_scoped : scope-aware RRF (from 0009) — THE API PATH ────
--     Enforces the key's scope (source_types[], data_source_ids[], collection_ids[]
--     — empty array = no restriction on that dimension) INSIDE the DB. Returns
--     ONLY the columns the app reads: never the 1024-dim embedding or fts over
--     the wire. Signature/param names are frozen (app calls them by name).
create or replace function public.hybrid_search_scoped(
  p_org_id uuid,
  query_text text,
  query_embedding vector(1024),
  p_source_types text[] default '{}',
  p_data_source_ids uuid[] default '{}',
  p_collection_ids uuid[] default '{}',
  match_count int default 40,
  full_text_weight float default 1.0,
  semantic_weight float default 1.0,
  rrf_k int default 50
)
returns table (
  id uuid,
  document_id uuid,
  parent_id uuid,
  content text,
  metadata jsonb,
  source_type text
)
language sql
stable
set search_path = public, extensions
-- Same rationale as hybrid_search (§5.1): keep the HNSW candidate list >= the
-- semantic leg's LIMIT so recall is not silently capped at the default 40.
set hnsw.ef_search = 200
as $$
  -- NOT MATERIALIZED is REQUIRED here: `scoped` is referenced more than once
  -- (full_text, semantic, final projection). A multiply-referenced CTE is
  -- materialized into an un-indexed work table in Postgres 12+, which would force
  -- the semantic leg's `order by embedding <=> query_embedding` into a full
  -- sequential scan + exact kNN sort (defeating chunks_embedding_idx / HNSW) and
  -- the full_text leg off the fts GIN index. Inlining every reference lets each
  -- leg run against the base table so both indexes stay eligible — matching §5.1.
  with scoped as not materialized (
    select c.id, c.document_id, c.parent_id, c.content, c.metadata, c.source_type, c.fts, c.embedding
    from public.chunks c
    where c.org_id = p_org_id
      and (cardinality(p_source_types)    = 0 or c.source_type    = any(p_source_types))
      and (cardinality(p_data_source_ids) = 0 or c.data_source_id = any(p_data_source_ids))
      and (cardinality(p_collection_ids)  = 0 or c.collection_ids && p_collection_ids)
  ),
  full_text as (
    select id, row_number() over (
             order by ts_rank_cd(fts, websearch_to_tsquery('english', query_text)) desc
           ) as rank_ix
    from scoped
    where fts @@ websearch_to_tsquery('english', query_text)
    order by rank_ix
    limit least(match_count, 200) * 2
  ),
  semantic as (
    select id, row_number() over (order by embedding <=> query_embedding) as rank_ix
    from scoped
    order by rank_ix
    limit least(match_count, 200) * 2
  )
  select s.id, s.document_id, s.parent_id, s.content, s.metadata, s.source_type
  from full_text
  full outer join semantic on full_text.id = semantic.id
  join scoped s on s.id = coalesce(full_text.id, semantic.id)
  order by
    coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
    coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight desc
  limit least(match_count, 200);
$$;

-- ── 5.3 api_key_is_active : usability helper (from 0005) ────────────────────
--     Uses now(), so correctly STABLE (not IMMUTABLE as the original migration
--     declared). search_path pinned; composite arg type fully qualified.
create or replace function public.api_key_is_active(k public.api_keys)
returns boolean
language sql
stable
set search_path = ''
as $$
  select k.revoked_at is null and (k.expires_at is null or k.expires_at > now());
$$;

-- ── 5.4 set_updated_at : generic moddatetime-style trigger ──────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.documents;
create trigger set_updated_at before update on public.documents
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.data_sources;
create trigger set_updated_at before update on public.data_sources
  for each row execute function public.set_updated_at();


-- ============================================================================
--  §6  AUTH HOOK — custom_access_token_hook (injects org_id into the JWT)
-- ============================================================================
-- Makes RLS (§7) actually enforce for authenticated dashboard users: on every
-- token mint GoTrue calls this hook, which looks up the caller's org from
-- public.org_members (by Auth uid) and writes it to the "org_id" claim that the
-- policies read via auth.jwt() ->> 'org_id'.
--
-- SECURITY INVOKER (default) + pinned empty search_path + fully-qualified names
-- (no search_path injection). GoTrue runs this hook as the supabase_auth_admin
-- role, which is authorized to read the lookup table by the grant + the
-- org_members_auth_admin_read policy added below. It must NOT be SECURITY DEFINER:
-- org_members has FORCE ROW LEVEL SECURITY (§7.1), which subjects even the table
-- owner to RLS. As DEFINER the SELECT would run as the function owner (postgres in
-- the SQL editor), for which no policy exists, so under FORCE RLS it would return
-- zero rows — v_org_id NULL, the org_id claim silently dropped, and RLS then
-- denying all authenticated access (fail-closed but non-functional). Running as
-- the invoker (supabase_auth_admin) makes the read robust regardless of the
-- owner's BYPASSRLS status.
--
-- >>> MANUAL STEP: Dashboard → Authentication → Hooks → Custom Access Token →
--     enable, schema = public, function = custom_access_token_hook. <<<
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims   jsonb;
  v_org_id uuid;
begin
  select om.org_id
    into v_org_id
  from public.org_members om
  where om.user_id = (event->>'user_id')::uuid
    and om.is_active = true
  order by om.created_at asc
  limit 1;

  claims := coalesce(event->'claims', '{}'::jsonb);
  if v_org_id is not null then
    -- store as text; policies cast back with ::uuid
    claims := jsonb_set(claims, '{org_id}', to_jsonb(v_org_id::text));
  end if;

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;

-- Grants required for the Auth service to run the hook and read the lookup table.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant select on public.org_members to supabase_auth_admin;
-- Keep the hook off-limits to normal API roles.
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;


-- ============================================================================
--  §7  ROW LEVEL SECURITY  (enable + FORCE on every tenant/user table)
-- ============================================================================
-- Per-command policies (select/insert/update/delete), all scoped to the caller's
-- org via (auth.jwt() ->> 'org_id')::uuid, WITH CHECK on every write so a row can
-- never be created/moved outside the caller's tenant. Policies target the
-- "authenticated" role; service_role has BYPASSRLS and is unaffected (server
-- ingestion keeps working). FORCE makes RLS apply even to the table owner.
-- Old permissive "org_isolation_*" policies from 0003/0004/0006/0007/0008 are
-- dropped first so the hardened per-command set is the only one in force.

-- ── 7.1 org_members : first, so the auth hook can also read it under RLS ─────
alter table public.org_members enable row level security;
alter table public.org_members force  row level security;
drop policy if exists org_isolation_org_members on public.org_members;
drop policy if exists org_members_select on public.org_members;
drop policy if exists org_members_insert on public.org_members;
drop policy if exists org_members_update on public.org_members;
drop policy if exists org_members_delete on public.org_members;
drop policy if exists org_members_auth_admin_read on public.org_members;
create policy org_members_select on public.org_members for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy org_members_insert on public.org_members for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy org_members_update on public.org_members for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy org_members_delete on public.org_members for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
-- Let the Auth service read memberships while minting a token (no JWT yet).
create policy org_members_auth_admin_read on public.org_members for select
  to supabase_auth_admin using (true);

-- ── 7.2 orgs : row identified by id (not org_id) ────────────────────────────
alter table public.orgs enable row level security;
alter table public.orgs force  row level security;
drop policy if exists org_isolation_orgs on public.orgs;
drop policy if exists orgs_select on public.orgs;
drop policy if exists orgs_insert on public.orgs;
drop policy if exists orgs_update on public.orgs;
drop policy if exists orgs_delete on public.orgs;
create policy orgs_select on public.orgs for select to authenticated
  using (id = (auth.jwt() ->> 'org_id')::uuid);
create policy orgs_insert on public.orgs for insert to authenticated
  with check (id = (auth.jwt() ->> 'org_id')::uuid);
create policy orgs_update on public.orgs for update to authenticated
  using (id = (auth.jwt() ->> 'org_id')::uuid)
  with check (id = (auth.jwt() ->> 'org_id')::uuid);
create policy orgs_delete on public.orgs for delete to authenticated
  using (id = (auth.jwt() ->> 'org_id')::uuid);

-- ── 7.3 prompts : global rows (org_id NULL) are READABLE by all; writes must
--        belong to the caller's org (no tenant can write/replace a global) ────
alter table public.prompts enable row level security;
alter table public.prompts force  row level security;
drop policy if exists org_isolation_prompts on public.prompts;
drop policy if exists prompts_select on public.prompts;
drop policy if exists prompts_insert on public.prompts;
drop policy if exists prompts_update on public.prompts;
drop policy if exists prompts_delete on public.prompts;
create policy prompts_select on public.prompts for select to authenticated
  using (org_id is null or org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy prompts_insert on public.prompts for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy prompts_update on public.prompts for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy prompts_delete on public.prompts for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- ── 7.4 Generic org_id-scoped tables (identical per-command shape) ──────────
-- documents
alter table public.documents enable row level security;
alter table public.documents force  row level security;
drop policy if exists org_isolation_documents on public.documents;
drop policy if exists documents_select on public.documents;
drop policy if exists documents_insert on public.documents;
drop policy if exists documents_update on public.documents;
drop policy if exists documents_delete on public.documents;
create policy documents_select on public.documents for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy documents_insert on public.documents for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy documents_update on public.documents for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy documents_delete on public.documents for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- chunks
alter table public.chunks enable row level security;
alter table public.chunks force  row level security;
drop policy if exists org_isolation_chunks on public.chunks;
drop policy if exists chunks_select on public.chunks;
drop policy if exists chunks_insert on public.chunks;
drop policy if exists chunks_update on public.chunks;
drop policy if exists chunks_delete on public.chunks;
create policy chunks_select on public.chunks for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy chunks_insert on public.chunks for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy chunks_update on public.chunks for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy chunks_delete on public.chunks for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- conversations
alter table public.conversations enable row level security;
alter table public.conversations force  row level security;
drop policy if exists org_isolation_conversations on public.conversations;
drop policy if exists conversations_select on public.conversations;
drop policy if exists conversations_insert on public.conversations;
drop policy if exists conversations_update on public.conversations;
drop policy if exists conversations_delete on public.conversations;
create policy conversations_select on public.conversations for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy conversations_insert on public.conversations for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy conversations_update on public.conversations for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy conversations_delete on public.conversations for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- messages
alter table public.messages enable row level security;
alter table public.messages force  row level security;
drop policy if exists org_isolation_messages on public.messages;
drop policy if exists messages_select on public.messages;
drop policy if exists messages_insert on public.messages;
drop policy if exists messages_update on public.messages;
drop policy if exists messages_delete on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy messages_insert on public.messages for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy messages_update on public.messages for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy messages_delete on public.messages for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- api_keys
alter table public.api_keys enable row level security;
alter table public.api_keys force  row level security;
drop policy if exists org_isolation_api_keys on public.api_keys;
drop policy if exists api_keys_select on public.api_keys;
drop policy if exists api_keys_insert on public.api_keys;
drop policy if exists api_keys_update on public.api_keys;
drop policy if exists api_keys_delete on public.api_keys;
create policy api_keys_select on public.api_keys for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy api_keys_insert on public.api_keys for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy api_keys_update on public.api_keys for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy api_keys_delete on public.api_keys for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- data_sources
alter table public.data_sources enable row level security;
alter table public.data_sources force  row level security;
drop policy if exists org_isolation_data_sources on public.data_sources;
drop policy if exists data_sources_select on public.data_sources;
drop policy if exists data_sources_insert on public.data_sources;
drop policy if exists data_sources_update on public.data_sources;
drop policy if exists data_sources_delete on public.data_sources;
create policy data_sources_select on public.data_sources for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy data_sources_insert on public.data_sources for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy data_sources_update on public.data_sources for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy data_sources_delete on public.data_sources for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- ingestion_runs
alter table public.ingestion_runs enable row level security;
alter table public.ingestion_runs force  row level security;
drop policy if exists org_isolation_ingestion_runs on public.ingestion_runs;
drop policy if exists ingestion_runs_select on public.ingestion_runs;
drop policy if exists ingestion_runs_insert on public.ingestion_runs;
drop policy if exists ingestion_runs_update on public.ingestion_runs;
drop policy if exists ingestion_runs_delete on public.ingestion_runs;
create policy ingestion_runs_select on public.ingestion_runs for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy ingestion_runs_insert on public.ingestion_runs for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy ingestion_runs_update on public.ingestion_runs for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy ingestion_runs_delete on public.ingestion_runs for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- connectors
alter table public.connectors enable row level security;
alter table public.connectors force  row level security;
drop policy if exists org_isolation_connectors on public.connectors;
drop policy if exists connectors_select on public.connectors;
drop policy if exists connectors_insert on public.connectors;
drop policy if exists connectors_update on public.connectors;
drop policy if exists connectors_delete on public.connectors;
create policy connectors_select on public.connectors for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy connectors_insert on public.connectors for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy connectors_update on public.connectors for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy connectors_delete on public.connectors for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- connector_grants
alter table public.connector_grants enable row level security;
alter table public.connector_grants force  row level security;
drop policy if exists org_isolation_connector_grants on public.connector_grants;
drop policy if exists connector_grants_select on public.connector_grants;
drop policy if exists connector_grants_insert on public.connector_grants;
drop policy if exists connector_grants_update on public.connector_grants;
drop policy if exists connector_grants_delete on public.connector_grants;
create policy connector_grants_select on public.connector_grants for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy connector_grants_insert on public.connector_grants for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy connector_grants_update on public.connector_grants for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy connector_grants_delete on public.connector_grants for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- collections
alter table public.collections enable row level security;
alter table public.collections force  row level security;
drop policy if exists org_isolation_collections on public.collections;
drop policy if exists collections_select on public.collections;
drop policy if exists collections_insert on public.collections;
drop policy if exists collections_update on public.collections;
drop policy if exists collections_delete on public.collections;
create policy collections_select on public.collections for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy collections_insert on public.collections for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy collections_update on public.collections for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy collections_delete on public.collections for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- document_collections
alter table public.document_collections enable row level security;
alter table public.document_collections force  row level security;
drop policy if exists org_isolation_document_collections on public.document_collections;
drop policy if exists document_collections_select on public.document_collections;
drop policy if exists document_collections_insert on public.document_collections;
drop policy if exists document_collections_update on public.document_collections;
drop policy if exists document_collections_delete on public.document_collections;
create policy document_collections_select on public.document_collections for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy document_collections_insert on public.document_collections for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy document_collections_update on public.document_collections for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy document_collections_delete on public.document_collections for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- usage_events
alter table public.usage_events enable row level security;
alter table public.usage_events force  row level security;
drop policy if exists org_isolation_usage_events on public.usage_events;
drop policy if exists usage_events_select on public.usage_events;
drop policy if exists usage_events_insert on public.usage_events;
drop policy if exists usage_events_update on public.usage_events;
drop policy if exists usage_events_delete on public.usage_events;
create policy usage_events_select on public.usage_events for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy usage_events_insert on public.usage_events for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy usage_events_update on public.usage_events for update to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy usage_events_delete on public.usage_events for delete to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);


-- ============================================================================
--  §8  GRANTS  (service_role only for tenant data; RLS is defense-in-depth)
-- ============================================================================
-- The whole app reaches tenant tables ONLY through the service-role client
-- (supabaseAdmin()), which BYPASSES RLS by design. The `authenticated` role is
-- used SOLELY for GoTrue auth (getUser / sign-in / sign-out) — never for
-- PostgREST table access. RBAC (super_admin vs admin, granular per-resource
-- permissions) is enforced in app code (e.g. role changes are super_admin-only
-- and permissions are sanitized against an allow-list). The per-command RLS
-- policies (§7) only scope on org_id, so granting `authenticated` direct CRUD
-- would let any signed-in low-privilege admin call PostgREST with their session
-- token and, once the auth hook puts org_id in the JWT, run e.g.
--   UPDATE org_members SET role='super_admin' WHERE org_id=<their org>
-- fully bypassing the app-layer RBAC (an intra-org privilege escalation; RLS
-- still blocks cross-tenant access). Because the app never uses `authenticated`
-- for data, we EXPLICITLY REVOKE those privileges so PostgREST direct access is
-- denied while the app keeps working and RLS remains as defense-in-depth. If a
-- future feature needs authenticated RLS reads, grant SELECT only (never blanket
-- INSERT/UPDATE/DELETE on org_members) and add permission-aware policies.
grant usage on schema public to anon, authenticated, service_role;

revoke select, insert, update, delete on
  public.orgs, public.org_members, public.documents, public.chunks,
  public.prompts, public.conversations, public.messages, public.api_keys,
  public.data_sources, public.ingestion_runs, public.connectors,
  public.connector_grants, public.collections, public.document_collections,
  public.usage_events
from authenticated, anon;

grant all on
  public.orgs, public.org_members, public.documents, public.chunks,
  public.prompts, public.conversations, public.messages, public.api_keys,
  public.data_sources, public.ingestion_runs, public.connectors,
  public.connector_grants, public.collections, public.document_collections,
  public.usage_events
to service_role;

-- RPCs: grant to authenticated + service_role, then re-lock the auth hook.
-- Postgres grants EXECUTE to PUBLIC by default on every new function, so without
-- the revokes below anon/public would retain implicit EXECUTE on the data and
-- helper functions (contradicting "anon gets nothing"). Lock them to the intended
-- roles; authenticated + service_role keep EXECUTE from the grant above.
grant execute on all functions in schema public to authenticated, service_role;
revoke execute on function
  public.hybrid_search(uuid, text, vector, int, float, float, int, text),
  public.hybrid_search_scoped(uuid, text, vector, text[], uuid[], uuid[], int, float, float, int),
  public.api_key_is_active(public.api_keys),
  public.set_updated_at()
from anon, public;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;


-- ============================================================================
--  §9  HIGH-VOLUME TUNING  (autovacuum) + COMMENTS
-- ============================================================================
-- 9.1 Autovacuum for the two high-churn tables. chunks: heavy bulk inserts +
--     background updates. usage_events: append-only, one row per request.
alter table public.chunks set (
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_limit    = 2000
);
alter table public.usage_events set (
  autovacuum_vacuum_scale_factor        = 0.02,
  autovacuum_analyze_scale_factor       = 0.01,
  autovacuum_vacuum_insert_scale_factor = 0.05   -- PG13+: vacuum after many inserts too
);

-- 9.2 Table + column comments (documentation lives with the schema).
comment on table public.orgs                 is 'Tenant root. Every per-tenant row carries org_id and references this table.';
comment on table public.org_members          is 'Admins/users within an org; user_id is the Supabase Auth uid. Source of the JWT org_id claim (see custom_access_token_hook).';
comment on table public.documents            is 'Source of truth per ingested item. De-duplicated per (org_id, content_hash) in app code (check-then-insert).';
comment on column public.documents.content_hash is 'SHA-256 of redacted text; drives ingest de-duplication via the non-unique partial index documents_org_content_hash_idx (§3.3).';
comment on table public.chunks               is 'Retrievable child pieces with optional parent for context expansion. Hybrid search target.';
comment on column public.chunks.embedding    is 'pgvector(1024) from text-embedding-3-large. Never mix embedding models in this column (see embedding_version).';
comment on column public.chunks.fts          is 'Generated tsvector(english) of content; GIN-indexed for full-text half of hybrid search.';
comment on column public.chunks.collection_ids is 'Denormalized collection membership; GIN-indexed for fast scope filtering.';
comment on table public.prompts              is 'Versioned system prompts (org_id NULL = global). Editable from the dashboard without redeploy.';
comment on table public.api_keys             is 'Scoped credentials. Only key_prefix (non-secret) + key_hash (SHA-256) are stored; the secret is shown once.';
comment on column public.api_keys.capabilities is 'Subset of {chat,retrieve,generate} enforced by check + app.';
comment on table public.data_sources         is 'Registry of ingest sources. auth_secret_ref points to where the secret lives (env/vault), never the secret itself.';
comment on table public.ingestion_runs       is 'One row per ingest attempt (manual/schedule/webhook/upload) — provenance + audit.';
comment on table public.connectors           is 'External integrations (MCP server / HTTP API) the Brain exposes to consumer apps.';
comment on table public.connector_grants     is 'Which scoped api_key may use which connector.';
comment on table public.collections          is 'Named grouping of documents; finest-grained key scope dimension.';
comment on table public.document_collections is 'Many-to-many map of documents to collections.';
comment on table public.usage_events         is 'Per-request metering (tokens/cost/latency). High-volume; see optional partitioning in §10.';
comment on function public.hybrid_search(uuid, text, vector, int, float, float, int, text)
  is 'RRF of vector + full-text over one org (optionally one source_type). Returns SETOF chunks. STABLE.';
comment on function public.hybrid_search_scoped(uuid, text, vector, text[], uuid[], uuid[], int, float, float, int)
  is 'Scope-aware RRF. Enforces source_types/data_source_ids/collection_ids; returns only id/document_id/parent_id/content/metadata/source_type (never embedding/fts). STABLE.';
comment on function public.custom_access_token_hook(jsonb)
  is 'Supabase Custom Access Token hook: injects the caller''s org_id claim from org_members so RLS enforces for dashboard users.';


-- ============================================================================
--  §10  OPTIONAL: usage_events monthly RANGE partitioning + pg_cron
-- ============================================================================
-- The non-partitioned public.usage_events created above works out of the box.
-- At very high request volume you may prefer native monthly partitioning so old
-- months can be detached/dropped cheaply and vacuum/scan stay bounded.
--
-- Postgres cannot convert an existing plain table into a partitioned one in
-- place, so this is a GREENFIELD opt-in: run it on a fresh project BEFORE any
-- usage_events rows exist (or migrate data manually). Everything below is inside
-- a block comment so the default script never executes it — uncomment to adopt.
--
-- ── 10.1 Partitioned table (replaces the plain §2.12 table on greenfield) ────
-- IMPORTANT: §2.12 unconditionally creates public.usage_events as a PLAIN table
-- earlier in this file, so a bare `create table if not exists` here would be a
-- silent NO-OP and the partitioned definition would never take effect. The
-- explicit DROP below makes §10 the sole definition. It is DATA-DESTROYING and is
-- GREENFIELD-ONLY: run it on a fresh project BEFORE any usage_events rows exist
-- (or migrate data manually first). This is why §10 ships commented out.
/*
drop table if exists public.usage_events cascade;   -- GREENFIELD ONLY: destroys rows + RLS/indexes on the plain table

create table if not exists public.usage_events (
  id            uuid not null default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  api_key_id    uuid references public.api_keys(id) on delete set null,
  user_id       uuid,
  kind          text not null check (kind in ('chat','retrieve','generate','embed')),
  model         text,
  tier          text,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  cost_usd      numeric(12,6) not null default 0,
  latency_ms    int,
  cached        boolean not null default false,
  created_at    timestamptz not null default now(),
  primary key (id, created_at)                    -- PK must include the partition key
) partition by range (created_at);

-- DEFAULT partition catches any row whose month partition does not yet exist, so
-- inserts NEVER fail even if maintenance lapses.
create table if not exists public.usage_events_default
  partition of public.usage_events default;

-- Recreate the read indexes on the partitioned parent (propagate to partitions).
-- (usage_events_org_created_desc_idx is intentionally omitted — see §4.11: the
-- ascending (org_id, created_at) index already serves desc ordering.)
create index if not exists usage_events_org_created_idx on public.usage_events (org_id, created_at);
create index if not exists usage_events_key_idx         on public.usage_events (api_key_id);

-- NOTE: re-apply the §7 RLS + §8 revokes on usage_events after this recreate, and
-- re-run the §9 autovacuum ALTER for the parent — the DROP above removed them.

-- ── 10.2 Helper: create the partition for a given month (idempotent) ─────────
create or replace function public.ensure_usage_events_partition(p_month date)
returns void
language plpgsql
set search_path = ''
as $fn$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('usage_events_%s', to_char(v_start, 'YYYYMM'));
begin
  execute format(
    'create table if not exists public.%I partition of public.usage_events for values from (%L) to (%L)',
    v_name, v_start, v_end
  );
  -- The §9 autovacuum storage params on the parent do NOT propagate to child
  -- partitions (a partitioned parent has no storage), so apply the high-volume
  -- insert/analyze tuning to each partition as it is created.
  execute format(
    'alter table public.%I set (autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.01)',
    v_name
  );
end;
$fn$;

-- Pre-create the current and next month right now.
select public.ensure_usage_events_partition(current_date);
select public.ensure_usage_events_partition((current_date + interval '1 month')::date);

-- ── 10.3 pg_cron maintenance (guarded on the extension existing) ─────────────
-- Runs on the 25th at 02:00 UTC: pre-create next month's partition, then ANALYZE.
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'usage_events_next_partition',
      '0 2 25 * *',
      $job$ select public.ensure_usage_events_partition((current_date + interval '1 month')::date); $job$
    );
    perform cron.schedule(
      'usage_events_analyze',
      '30 2 25 * *',
      $job$ analyze public.usage_events; $job$
    );
  end if;
end;
$cron$;
*/


-- ============================================================================
--  §11  OPTIONAL: halfvec HNSW upgrade (halves vector index memory)
-- ============================================================================
-- pgvector >= 0.7.0 adds halfvec (16-bit floats). Keeping the PRECISE vector(1024)
-- column for exact re-ranking but indexing the half-precision cast halves HNSW
-- index memory with negligible recall loss at 1024 dims. This does NOT change the
-- chunks.embedding type or the app contract — it adds a second, expression index.
-- Build it CONCURRENTLY (top level, not in a transaction) on a large existing
-- table; drop the full-precision HNSW index afterwards only if you want to switch.
/*
-- 1) Build the half-precision HNSW index (top level; may take a while):
create index concurrently if not exists chunks_embedding_halfvec_idx
  on public.chunks using hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)
  with (m = 16, ef_construction = 128);

-- 2) To route queries through it, order by the SAME cast, e.g.:
--        order by embedding::halfvec(1024) <=> query_embedding::halfvec(1024)
--    (Adjust hybrid_search / hybrid_search_scoped's semantic CTE accordingly.)
-- 3) Optionally drop the full-precision index once validated:
--        drop index concurrently if exists public.chunks_embedding_idx;
*/


-- ============================================================================
--  §12  OPTIONAL: CREATE INDEX CONCURRENTLY variants for LARGE existing tables
-- ============================================================================
-- The §4 indexes use plain "create index if not exists", which takes an
-- ACCESS EXCLUSIVE lock for the build. On a fresh/small database that is fine.
-- If you are adding these to a LARGE, LIVE table and cannot afford the lock, run
-- the CONCURRENTLY equivalents INSTEAD — one at a time, at top level, OUTSIDE any
-- transaction (they cannot run inside a transaction/DO block or the SQL editor's
-- implicit wrapper). Example set (uncomment + run individually as needed):
/*
create index concurrently if not exists chunks_embedding_idx on public.chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 128);
create index concurrently if not exists chunks_fts_idx           on public.chunks using gin (fts);
create index concurrently if not exists chunks_collections_gin   on public.chunks using gin (collection_ids);
create index concurrently if not exists chunks_org_source_idx    on public.chunks (org_id, source_type);
create index concurrently if not exists chunks_org_dsource_idx   on public.chunks (org_id, data_source_id);
create index concurrently if not exists usage_events_org_created_idx
  on public.usage_events (org_id, created_at);
*/

-- ============================================================================
--  END OF brain_full.sql
-- ============================================================================
