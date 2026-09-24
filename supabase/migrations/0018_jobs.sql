-- Background jobs: long-running, batched work over ANY data (consultant calls
-- today, other connectors later). A job fans out into TASKS; each task is run by
-- a worker ("agent") that reads a bounded slice and writes structured results.
-- Progress is polled by the dashboard. Executed by a durable runner (Trigger.dev)
-- or drained by a Vercel cron, so nothing depends on a single request finishing.
--
-- Run once in Supabase (SQL editor) or via the CLI.

create table if not exists jobs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  type            text not null,                       -- e.g. 'deep_call_audit'
  title           text not null,
  params          jsonb not null default '{}'::jsonb,  -- the job's input filter
  status          text not null default 'queued'
                    check (status in ('queued','running','completed','partial','failed','canceled')),
  total_tasks     int not null default 0,
  completed_tasks int not null default 0,
  failed_tasks    int not null default 0,
  result          jsonb,                               -- final aggregated report
  error           text,
  created_by      uuid,
  runner_ref      text,                                -- Trigger.dev run id, if used
  deadline_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index if not exists jobs_org_idx on jobs(org_id);
create index if not exists jobs_status_idx on jobs(org_id, status, created_at desc);

create table if not exists job_tasks (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references jobs(id) on delete cascade,
  org_id      uuid not null references orgs(id) on delete cascade,
  idx         int not null default 0,
  label       text not null default '',
  status      text not null default 'queued'
                check (status in ('queued','running','completed','failed')),
  input       jsonb not null default '{}'::jsonb,       -- the task's slice of work
  result      jsonb,                                    -- structured findings
  error       text,
  attempts    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index if not exists job_tasks_job_idx on job_tasks(job_id, idx);
create index if not exists job_tasks_claim_idx on job_tasks(org_id, status);

alter table jobs enable row level security;
alter table job_tasks enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'jobs' and policyname = 'org_isolation_jobs') then
    create policy org_isolation_jobs on jobs for all
      using (org_id = (auth.jwt() ->> 'org_id')::uuid)
      with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'job_tasks' and policyname = 'org_isolation_job_tasks') then
    create policy org_isolation_job_tasks on job_tasks for all
      using (org_id = (auth.jwt() ->> 'org_id')::uuid)
      with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
  end if;
end $$;
