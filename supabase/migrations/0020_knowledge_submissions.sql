-- Knowledge submissions: an approval queue for human-uploaded knowledge.
--
-- When a non-super-admin WITHOUT the documents:approve grant uploads knowledge,
-- the commit does NOT ingest. Instead a pending row is parked here carrying
-- everything needed to replay the commit later (the resolved text + the compiled
-- proposal), and it goes live ONLY when a super admin (or a member granted
-- documents:approve) approves it. Super admins / approvers commit immediately as
-- before. Automated connector/cron syncs are system ingestion and never land here.
--
-- Every row is org-scoped. All dashboard/API access goes through the service-role
-- client and the ROUTE enforces scope with explicit filters (the pattern for every
-- table here); RLS below is the defence-in-depth backstop keyed on the JWT org_id.
--
-- Run once in Supabase (SQL editor) or via the CLI.

create table if not exists knowledge_submissions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id) on delete cascade,
  submitted_by        uuid references org_members(id) on delete set null,   -- member id (admin.memberId)
  submitted_by_email  text not null,                                        -- provenance / createdBy on replay
  title               text,
  kind                text not null
                        check (kind in ('paste','file','link','bulk','learning')),
  commit_via          text not null default 'compile'
                        check (commit_via in ('compile','ingest_one')),     -- how approve replays the commit
  source_type         text,                 -- e.g. 'document' for bulk uploads
  intelligence_class  text,                 -- compile kinds only
  bucket              text,                 -- business_reality bucket (compile only)
  payload             jsonb not null,       -- everything to replay the commit (resolved text, hints, overrides, …)
  preview             jsonb,                -- the compiled proposal shown to the reviewer (compile kinds)
  status              text not null default 'pending'
                        check (status in ('pending','approved','rejected')),
  review_note         text,
  reviewed_by         uuid references org_members(id) on delete set null,
  reviewed_at         timestamptz,
  committed_object_id uuid,                 -- knowledge_object / document id created on approve (audit)
  storage_path        text,                 -- null in the default design; set only if deferring extraction
  created_at          timestamptz not null default now()
);

create index if not exists knowledge_submissions_org_status_idx
  on knowledge_submissions(org_id, status, created_at desc);
create index if not exists knowledge_submissions_submitter_idx
  on knowledge_submissions(org_id, submitted_by, created_at desc);

alter table knowledge_submissions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'knowledge_submissions' and policyname = 'org_isolation_knowledge_submissions'
  ) then
    create policy org_isolation_knowledge_submissions on knowledge_submissions for all
      using (org_id = (auth.jwt() ->> 'org_id')::uuid)
      with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
  end if;
end $$;
