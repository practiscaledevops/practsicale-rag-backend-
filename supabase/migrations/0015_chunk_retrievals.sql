-- 0015_chunk_retrievals.sql — per-chunk retrieval log.
-- One row per chunk that was placed in an answer's context, with its rerank score
-- and whether the answer cited it. Powers the document/chunk inspectors
-- (retrieval count, last retrieved, citation usage) and "most-retrieved" views.
-- RLS ON with NO policies = service-role only (the dashboard reads it server-side).
-- The app degrades gracefully (logging skipped, stats show "—") until this exists.

create table if not exists public.chunk_retrievals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  chunk_id    uuid not null,
  document_id uuid references documents(id) on delete cascade,
  score       numeric(4,3),
  cited       boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists chunk_retrievals_chunk_idx on public.chunk_retrievals (chunk_id, created_at desc);
create index if not exists chunk_retrievals_doc_idx on public.chunk_retrievals (document_id, created_at desc);
create index if not exists chunk_retrievals_org_idx on public.chunk_retrievals (org_id, created_at desc);

alter table public.chunk_retrievals enable row level security;
