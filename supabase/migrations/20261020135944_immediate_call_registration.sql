-- Register newly saved calls before model/embedding work. Same identity locks
-- as sync_source_document: a replay or late registration cannot replace a fully
-- indexed body. Service-only, tenant/source validated, no new public tables.
begin;
create or replace function public.publish_scoring_metadata(
  p_org_id uuid, p_source_id uuid, p_record_id text,
  p_metadata jsonb, p_title text, p_summary text
) returns table(document_id uuid, source_type text, registered boolean)
language plpgsql security invoker set search_path = public, extensions as $$
declare
  kind text;
  old_doc public.documents%rowtype;
  doc_id uuid;
  old_keys text[];
  body_revision text;
  ready boolean;
  meta jsonb;
  fresh boolean;
begin
  if not exists (select 1 from public.data_sources s where s.id=p_source_id and s.org_id=p_org_id and s.source_type='call_score' and s.is_active)
    or nullif(p_record_id,'') is null or p_metadata->>'source_record_id' is distinct from p_record_id
    or nullif(p_metadata->>'source_updated_at','') is null or nullif(p_summary,'') is null or length(p_summary)>16000 then
    raise exception 'Invalid scoring registration';
  end if;
  perform (p_metadata->>'source_updated_at')::timestamptz;
  foreach kind in array array['call_score','transcript'] loop
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':'||p_source_id::text||':'||kind||':'||p_record_id,0));
    select d.* into old_doc from public.documents d where d.org_id=p_org_id and d.data_source_id=p_source_id
      and d.source_type=kind and d.metadata->>'source_record_id'=p_record_id order by d.created_at,d.id limit 1;
    doc_id := old_doc.id;
    fresh := doc_id is null;
    if not fresh and nullif(old_doc.metadata->>'source_updated_at','') is not null
      and (old_doc.metadata->>'source_updated_at')::timestamptz > (p_metadata->>'source_updated_at')::timestamptz then
      document_id := doc_id; source_type := kind; registered := false; return next; continue;
    end if;
    -- JSON null is intentional: a shell never claims a completed body revision.
    body_revision := case when old_doc.metadata ? 'source_body_updated_at' then old_doc.metadata->>'source_body_updated_at'
      else old_doc.metadata->>'source_updated_at' end;
    ready := not fresh and body_revision is not null and exists(select 1 from public.chunks c where c.org_id=p_org_id and c.document_id=doc_id);
    meta := (p_metadata - 'source_body_updated_at' - 'source_index_state') || jsonb_build_object(
      'source_body_updated_at',body_revision,'source_index_state',case when ready then 'ready' else 'pending' end);
    if fresh then
      insert into public.documents(org_id,data_source_id,source_type,title,content_hash,metadata,intelligence_class,domain)
        values(p_org_id,p_source_id,kind,case when kind='transcript' then 'Transcript — '||p_title else p_title end,null,meta,'business_reality','sales') returning id into doc_id;
      if kind='call_score' then
        -- A factual metadata summary supports immediate keyword retrieval. No
        -- dummy vector, fake transcript, or model-generated content is inserted.
        insert into public.chunks(org_id,document_id,content,metadata,embedding,source_type,data_source_id,intelligence_class,domain)
          values(p_org_id,doc_id,p_summary,meta||jsonb_build_object('registration_summary',true),null,kind,p_source_id,'business_reality','sales');
      end if;
    else
      select coalesce(array_agg(k),'{}'::text[]) into old_keys from jsonb_object_keys(coalesce(old_doc.metadata,'{}')) k;
      update public.documents d set metadata=meta,title=case when kind='call_score' then p_title else d.title end,updated_at=now()
        where d.id=doc_id and d.org_id=p_org_id;
      update public.chunks c set metadata=(coalesce(c.metadata,'{}')-old_keys)||meta where c.org_id=p_org_id and c.document_id=doc_id;
    end if;
    document_id := doc_id; source_type := kind; registered := fresh; return next;
  end loop;
end $$;
revoke all on function public.publish_scoring_metadata(uuid,uuid,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.publish_scoring_metadata(uuid,uuid,text,jsonb,text,text) to service_role;
notify pgrst,'reload schema';
commit;
