-- 0007_connectors.sql : external integrations the Brain exposes to consumer apps.
--
-- A connector is a capability a consumer app (via its scoped key) can be granted:
-- an MCP server, or a third-party HTTP API (e.g. an image/video generation API).
-- The Brain holds the config; consumer apps never see the connector's secrets.

create table if not exists connectors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  slug text,
  kind text not null check (kind in ('mcp','http_api')),
  -- e.g. { "base_url": "...", "tools": [...] } for http_api,
  --      { "server_url": "...", "transport": "sse" } for mcp
  config jsonb not null default '{}',
  auth_secret_ref text,              -- reference to where the secret lives, not the secret
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (org_id, slug)
);
create index if not exists connectors_org_idx on connectors(org_id);

-- Which scoped keys (i.e. which consumer apps) may use which connector.
create table if not exists connector_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  connector_id uuid not null references connectors(id) on delete cascade,
  api_key_id uuid not null references api_keys(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (connector_id, api_key_id)
);
create index if not exists connector_grants_org_idx on connector_grants(org_id);
create index if not exists connector_grants_key_idx on connector_grants(api_key_id);

alter table connectors enable row level security;
alter table connector_grants enable row level security;

create policy org_isolation_connectors on connectors
  for all
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);

create policy org_isolation_connector_grants on connector_grants
  for all
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
