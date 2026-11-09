-- Permanent ID-only tombstones prevent in-flight pulls from resurrecting a
-- deleted source UUID. Delete uses the same locks as both ingestion RPCs.
begin;
create table if not exists public.scoring_deleted_records (
  org_id uuid not null references public.orgs(id),
  data_source_id uuid not null references public.data_sources(id),
  record_id uuid not null,
  deleted_at timestamptz not null,
  received_at timestamptz not null default now(),
  primary key(org_id,data_source_id,record_id)
);
alter table public.scoring_deleted_records enable row level security;
revoke all on public.scoring_deleted_records from public,anon,authenticated;
grant all on public.scoring_deleted_records to service_role;
alter table public.scoring_sync_events add column if not exists operation text not null default 'upsert'
  check (operation in ('upsert','delete'));
alter table public.scoring_sync_events add column if not exists source_updated_at timestamptz;

create or replace function public.delete_scoring_record(
  p_org_id uuid,p_source_id uuid,p_record_id uuid,p_deleted_at timestamptz
) returns integer language plpgsql security invoker set search_path='' as $$
declare removed integer;
begin
  if p_deleted_at is null or not exists(select 1 from public.data_sources s
    where s.id=p_source_id and s.org_id=p_org_id and s.source_type='call_score' and s.is_active) then
    raise exception 'Invalid scoring deletion identity';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':'||p_source_id::text||':call_score:'||p_record_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':'||p_source_id::text||':transcript:'||p_record_id::text,0));
  insert into public.scoring_deleted_records(org_id,data_source_id,record_id,deleted_at)
    values(p_org_id,p_source_id,p_record_id,p_deleted_at)
    on conflict(org_id,data_source_id,record_id) do update
      set deleted_at=greatest(public.scoring_deleted_records.deleted_at,excluded.deleted_at);
  -- Chunks, collection memberships, retrieval rows and entity mentions cascade.
  delete from public.documents d where d.org_id=p_org_id and d.data_source_id=p_source_id
    and d.source_type in ('call_score','transcript') and d.metadata->>'source_record_id'=p_record_id::text;
  get diagnostics removed = row_count;
  return removed;
end $$;
revoke all on function public.delete_scoring_record(uuid,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.delete_scoring_record(uuid,uuid,uuid,timestamptz) to service_role;

create or replace function public.reject_deleted_scoring_document() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.source_type in ('call_score','transcript') and new.data_source_id is not null
    and nullif(new.metadata->>'source_record_id','') is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.org_id::text||':'||new.data_source_id::text||':'||new.source_type||':'||(new.metadata->>'source_record_id'),0));
    if exists(select 1 from public.scoring_deleted_records t where t.org_id=new.org_id
      and t.data_source_id=new.data_source_id and t.record_id::text=new.metadata->>'source_record_id') then
      raise exception using errcode='PT410',message='Source call was deleted';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.reject_deleted_scoring_document() from public,anon,authenticated;
drop trigger if exists documents_scoring_deletion_guard on public.documents;
create trigger documents_scoring_deletion_guard before insert or update on public.documents
  for each row execute function public.reject_deleted_scoring_document();
commit;
notify pgrst,'reload schema';
