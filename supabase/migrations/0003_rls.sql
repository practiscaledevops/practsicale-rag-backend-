-- 0003_rls.sql : Row Level Security for multi-tenancy
-- These policies assume a JWT claim `org_id`. Adjust to your auth setup.
-- The service role bypasses RLS and is used by server-side ingestion.

alter table documents enable row level security;
alter table chunks enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table api_keys enable row level security;
alter table prompts enable row level security;

create policy org_isolation_documents on documents
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy org_isolation_chunks on chunks
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy org_isolation_conversations on conversations
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy org_isolation_messages on messages
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy org_isolation_api_keys on api_keys
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy org_isolation_prompts on prompts
  using (org_id is null or org_id = (auth.jwt() ->> 'org_id')::uuid);
