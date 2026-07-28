-- 0005_scoped_api_keys.sql : denormalize chunks for fast scope filtering,
-- and extend api_keys with the full scoped-permission model.

-- Denormalize source_type + data_source_id onto chunks so retrieval can filter
-- by a key's scope with plain indexed columns (instead of digging into jsonb).
-- Populated at ingest from the parent document.
alter table chunks add column if not exists source_type text;
alter table chunks add column if not exists data_source_id uuid;
create index if not exists chunks_source_type_idx on chunks(source_type);
create index if not exists chunks_data_source_idx on chunks(data_source_id);

-- Documents can originate from a registered pull/push data source.
alter table documents add column if not exists data_source_id uuid;
create index if not exists documents_data_source_idx on documents(data_source_id);

-- Extend api_keys into a scoped credential.
--   key_prefix   : shown in the UI (e.g. "psk_live_a1b2") to identify a key.
--   key_hash     : SHA-256 of the full secret; the secret is shown once, never stored.
--   Scope columns constrain what a request made with this key may see / do:
--     source_types    e.g. {call_score, coaching}
--     capabilities    subset of {chat, retrieve, generate}
--     data_source_ids limit to specific registered sources (empty = all in scope)
--     collection_ids  limit to specific document collections (empty = all in scope)
alter table api_keys add column if not exists key_prefix text;
alter table api_keys add column if not exists source_types text[] not null default '{}';
alter table api_keys add column if not exists capabilities text[] not null default '{chat}';
alter table api_keys add column if not exists data_source_ids uuid[] not null default '{}';
alter table api_keys add column if not exists collection_ids uuid[] not null default '{}';
alter table api_keys add column if not exists rate_limit_per_min int not null default 60;
alter table api_keys add column if not exists expires_at timestamptz;
alter table api_keys add column if not exists revoked_at timestamptz;
alter table api_keys add column if not exists created_by uuid;   -- org_member.id
alter table api_keys add column if not exists request_count bigint not null default 0;

create index if not exists api_keys_prefix_idx on api_keys(key_prefix);

-- Capabilities must be a subset of the known set.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_keys_capabilities_chk') then
    alter table api_keys add constraint api_keys_capabilities_chk
      check (capabilities <@ array['chat','retrieve','generate']::text[]);
  end if;
end $$;

-- A key is usable when it is not revoked and not expired.
create or replace function api_key_is_active(k api_keys)
returns boolean language sql immutable as $$
  select k.revoked_at is null and (k.expires_at is null or k.expires_at > now());
$$;
