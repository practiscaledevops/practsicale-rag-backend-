-- 0008_collections_and_usage.sql : document collections (finest-grained key scope)
-- and per-request usage metering (tokens, cost, latency).

-- A named grouping of documents. Keys can be scoped to specific collections.
create table if not exists collections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  slug text,
  description text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (org_id, slug)
);
create index if not exists collections_org_idx on collections(org_id);

-- Many-to-many: a document can belong to several collections.
create table if not exists document_collections (
  org_id uuid not null references orgs(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  collection_id uuid not null references collections(id) on delete cascade,
  primary key (document_id, collection_id)
);
create index if not exists document_collections_collection_idx on document_collections(collection_id);

-- Denormalize collection membership onto chunks for fast scope filtering at query time.
alter table chunks add column if not exists collection_ids uuid[] not null default '{}';
create index if not exists chunks_collections_gin on chunks using gin(collection_ids);

-- Per-request metering. One row per billable model call (chat/retrieve/generate/embed).
create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  api_key_id uuid references api_keys(id) on delete set null,
  user_id uuid,                      -- for dashboard/admin-initiated calls
  kind text not null check (kind in ('chat','retrieve','generate','embed')),
  model text,
  tier text,                         -- 'fast' | 'recommended' | 'max'
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(12,6) not null default 0,
  latency_ms int,
  cached boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_org_created_idx on usage_events(org_id, created_at);
create index if not exists usage_events_key_idx on usage_events(api_key_id);

alter table collections enable row level security;
alter table document_collections enable row level security;
alter table usage_events enable row level security;

create policy org_isolation_collections on collections
  for all
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);

create policy org_isolation_document_collections on document_collections
  for all
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);

create policy org_isolation_usage_events on usage_events
  for all
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
