-- 0014_query_log.sql — per-answer log for knowledge intelligence.
-- Captures what was asked, which documents were retrieved, and the outcome
-- (grounded / confidence / refused) so the dashboard can show most-used sources
-- and top unanswered questions (knowledge gaps). RLS ON with NO policies = the
-- service-role client only (the dashboard reads it server-side); a scoped spoke
-- key can never read another org's queries. The app degrades gracefully (logging
-- skipped, insights show "enable" hint) until this table exists.

create table if not exists public.query_log (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  api_key_id        uuid references api_keys(id) on delete set null,
  query             text not null,
  mode              text,
  source_types      text[],
  retrieved_doc_ids uuid[] not null default '{}',
  top_document_id   uuid,
  grounded          boolean,
  confidence        numeric(4,3),
  refused           boolean not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists query_log_org_idx on public.query_log (org_id, created_at desc);
-- Fast path for the "unanswered / weak" analytics.
create index if not exists query_log_gap_idx on public.query_log (org_id, created_at desc)
  where refused = true or grounded = false;

alter table public.query_log enable row level security;
-- No policies: reads/writes go through the service-role client only.
