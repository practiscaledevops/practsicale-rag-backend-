create table public.reliability_slots (
  scope text primary key, owner uuid, expires_at timestamptz not null, hits integer not null default 0
);
alter table public.reliability_slots enable row level security;
revoke all on public.reliability_slots from public, anon, authenticated;
grant select, insert, update, delete on public.reliability_slots to service_role;
create function public.take_rate_slot(p_scope text,p_limit integer) returns integer
language sql set search_path=public as $$
  insert into reliability_slots(scope,expires_at,hits)
  values ('rate:'||p_scope, date_trunc('minute',now())+interval '1 minute',1)
  on conflict(scope) do update set
    hits=case when reliability_slots.expires_at<=now() then 1 else reliability_slots.hits+1 end,
    expires_at=excluded.expires_at
  where reliability_slots.expires_at<=now() or reliability_slots.hits<p_limit
  returning hits
$$;
create function public.claim_ingest_slot(p_scope text,p_owner uuid) returns uuid
language sql set search_path=public as $$
  insert into reliability_slots(scope,owner,expires_at)
  values ('ingest:'||p_scope,p_owner,now()+interval '20 minutes')
  on conflict(scope) do update set owner=excluded.owner,expires_at=excluded.expires_at
  where reliability_slots.expires_at<=now()
  returning owner
$$;
create function public.release_ingest_slot(p_scope text,p_owner uuid) returns void
language sql set search_path=public as $$
  delete from reliability_slots where scope='ingest:'||p_scope and owner=p_owner
$$;
alter table public.job_tasks add column lease_until timestamptz;
create function public.claim_recoverable_job_task(p_org uuid default null)
returns setof public.job_tasks language plpgsql set search_path=public as $$
begin
  return query with candidate as (
    select t.id from job_tasks t join jobs j on j.id=t.job_id
    where (p_org is null or t.org_id=p_org) and j.status='running'
      and (t.status='queued' or (t.status='running' and coalesce(t.lease_until,t.started_at+interval '20 minutes',t.updated_at+interval '20 minutes')<=now()))
    order by t.idx,t.id limit 1 for update of t skip locked
  )
  update job_tasks t set
    status=case when t.attempts>=3 or j.deadline_at<=now() then 'failed' else 'running' end,
    error=case when t.attempts>=3 or j.deadline_at<=now() then 'Task recovery limit or job deadline reached' else null end,
    finished_at=case when t.attempts>=3 or j.deadline_at<=now() then now() else null end,
    lease_until=now()+interval '20 minutes', started_at=now(),updated_at=now(),attempts=t.attempts+1
  from candidate c,jobs j where t.id=c.id and j.id=t.job_id returning t.*;
end
$$;
revoke execute on function public.take_rate_slot(text,integer), public.claim_ingest_slot(text,uuid),
  public.release_ingest_slot(text,uuid), public.claim_recoverable_job_task(uuid) from public, anon, authenticated;
grant execute on function public.take_rate_slot(text,integer), public.claim_ingest_slot(text,uuid),
  public.release_ingest_slot(text,uuid), public.claim_recoverable_job_task(uuid) to service_role;

create table public.provider_usage_ledger (
 id uuid primary key, provider text not null, model text not null,
 billing_day date not null default (now() at time zone 'UTC')::date,
 reserved_usd numeric not null check (reserved_usd>=0),
 estimated_usd numeric check (estimated_usd>=0),
 input_tokens integer, output_tokens integer, created_at timestamptz not null default now()
);
create index on public.provider_usage_ledger(billing_day);
alter table public.provider_usage_ledger enable row level security;
revoke all on public.provider_usage_ledger from public, anon, authenticated;
grant select,insert,update on public.provider_usage_ledger to service_role;
create function public.reserve_provider_usage(p_id uuid,p_provider text,p_model text,p_reserved numeric,p_cap numeric)
returns boolean language plpgsql set search_path=public as $$
declare used numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('provider-usage-global',0));
  if p_cap is not null then
    select coalesce(sum(coalesce(estimated_usd,reserved_usd)),0) into used
      from provider_usage_ledger where billing_day=(now() at time zone 'UTC')::date;
    if used+p_reserved>p_cap then return false; end if;
  end if;
  insert into provider_usage_ledger(id,provider,model,reserved_usd) values(p_id,p_provider,p_model,p_reserved);
  return true;
end
$$;
revoke execute on function public.reserve_provider_usage(uuid,text,text,numeric,numeric) from public, anon, authenticated;
grant execute on function public.reserve_provider_usage(uuid,text,text,numeric,numeric) to service_role;

create function public.jobs_ready_to_finalize(p_org uuid default null)
returns setof uuid language sql set search_path=public as $$
  select j.id from jobs j where j.status='running' and j.total_tasks>0
  and (p_org is null or j.org_id=p_org)
  and not exists (select 1 from job_tasks t where t.job_id=j.id and t.status in ('queued','running'))
  order by j.updated_at,j.id limit 20
$$;
revoke execute on function public.jobs_ready_to_finalize(uuid) from public, anon, authenticated;
grant execute on function public.jobs_ready_to_finalize(uuid) to service_role;

