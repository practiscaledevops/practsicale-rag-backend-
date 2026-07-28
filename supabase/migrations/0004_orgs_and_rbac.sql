-- 0004_orgs_and_rbac.sql : tenant root + admin users with granular permissions
--
-- Tenancy model: first-party single-org now, multi-tenant-ready. Every existing
-- table already carries org_id (0001); here we add the orgs table it points to,
-- the admin/user membership table with a granular permission set, and foreign
-- keys for integrity. A super-admin can create more admins with specific access.

-- The tenant root.
create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  region text not null default 'ap-southeast-1',
  created_at timestamptz not null default now()
);

-- Admins / users within an org.
-- `user_id` is the Supabase Auth uid. `role` gives a coarse tier; `permissions`
-- is the fine-grained grant a super-admin assigns when creating an admin.
create table if not exists org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid,                       -- Supabase Auth uid (null until invited user signs in)
  email text not null,
  role text not null default 'admin' check (role in ('super_admin','admin')),
  -- Granular permissions, e.g.
  -- { "data_sources": ["read","write"], "prompts": ["read","write"],
  --   "api_keys": ["read","write","revoke"], "connectors": ["read","write"],
  --   "members": ["read","write"], "analytics": ["read"] }
  permissions jsonb not null default '{}',
  is_active boolean not null default true,
  created_by uuid,                    -- org_member.id of the admin who created this one
  created_at timestamptz not null default now(),
  unique (org_id, email)
);
create index if not exists org_members_org_idx on org_members(org_id);
create index if not exists org_members_user_idx on org_members(user_id);

-- Integrity: point the existing per-tenant tables at orgs.
-- (Fresh database — no rows to violate these. Guarded so re-runs are safe.)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'documents_org_fk') then
    alter table documents      add constraint documents_org_fk      foreign key (org_id) references orgs(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chunks_org_fk') then
    alter table chunks         add constraint chunks_org_fk         foreign key (org_id) references orgs(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'conversations_org_fk') then
    alter table conversations  add constraint conversations_org_fk  foreign key (org_id) references orgs(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messages_org_fk') then
    alter table messages       add constraint messages_org_fk       foreign key (org_id) references orgs(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'api_keys_org_fk') then
    alter table api_keys       add constraint api_keys_org_fk       foreign key (org_id) references orgs(id) on delete cascade;
  end if;
  -- prompts.org_id is nullable (global prompts allowed); FK still valid for non-null values.
  if not exists (select 1 from pg_constraint where conname = 'prompts_org_fk') then
    alter table prompts        add constraint prompts_org_fk        foreign key (org_id) references orgs(id) on delete cascade;
  end if;
end $$;

-- Row Level Security. Policies assume a JWT claim `org_id`; server code also
-- resolves org explicitly and uses the service role for writes.
alter table orgs enable row level security;
alter table org_members enable row level security;

create policy org_isolation_orgs on orgs
  for all
  using (id = (auth.jwt() ->> 'org_id')::uuid)
  with check (id = (auth.jwt() ->> 'org_id')::uuid);

create policy org_isolation_org_members on org_members
  for all
  using (org_id = (auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
