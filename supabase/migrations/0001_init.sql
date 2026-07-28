-- 0001_init.sql : extensions, core tables

create extension if not exists vector;
create extension if not exists pg_trgm;

-- Documents: source of truth per ingested item
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  source_type text not null check (source_type in ('transcript','call_score','coaching','document')),
  title text,
  uri text,
  content_hash text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists documents_org_idx on documents(org_id);
create index if not exists documents_type_idx on documents(source_type);
create index if not exists documents_hash_idx on documents(content_hash);

-- Chunks: retrievable pieces (child) with optional parent for context
create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  document_id uuid not null references documents(id) on delete cascade,
  parent_id uuid,
  content text not null,
  token_count int,
  metadata jsonb not null default '{}',
  embedding vector(1024),
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  model text default 'text-embedding-3-large',
  embedding_version int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists chunks_org_idx on chunks(org_id);
create index if not exists chunks_doc_idx on chunks(document_id);
create index if not exists chunks_fts_idx on chunks using gin(fts);
-- HNSW index for fast vector search (cosine)
create index if not exists chunks_embedding_idx on chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 128);

-- Editable, versioned prompts (so the dashboard can change behaviour without a redeploy)
create table if not exists prompts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  use_case text not null,
  version int not null default 1,
  content text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists prompts_usecase_idx on prompts(use_case);

-- Conversations and messages
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid,
  title text,
  created_at timestamptz not null default now()
);
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  org_id uuid not null,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  citations jsonb default '[]',
  created_at timestamptz not null default now()
);
create index if not exists messages_conv_idx on messages(conversation_id);

-- API keys per org (store only a hash)
create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text,
  key_hash text not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists api_keys_org_idx on api_keys(org_id);
