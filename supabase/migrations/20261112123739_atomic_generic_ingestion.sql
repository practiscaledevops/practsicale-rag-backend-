-- Prepare model work outside transactions; publish complete generations atomically.
-- Server-only, invoker rights: no new public or browser access.
create or replace function public.write_prepared_document_chunks(p_org_id uuid,p_document_id uuid,p_chunks jsonb)
returns integer language plpgsql security invoker set search_path = public, extensions as $$
declare doc public.documents%rowtype; cols uuid[]; written integer;
begin
  select d.* into doc from public.documents d where d.id=p_document_id and d.org_id=p_org_id for update;
  if doc.id is null then raise exception 'Document not found'; end if;
  if p_chunks is null or jsonb_typeof(p_chunks)<>'array' or jsonb_array_length(p_chunks)=0 then
    raise exception 'Empty or invalid chunk set';
  end if;
  if exists(select 1 from jsonb_array_elements(p_chunks) c where nullif(c->>'parent_id','') is not null
    and not exists(select 1 from jsonb_array_elements(p_chunks) parent where parent->>'id'=c->>'parent_id')) then
    raise exception 'Parent must belong to the new chunk generation';
  end if;
  select coalesce(array_agg(dc.collection_id),'{}'::uuid[]) into cols from public.document_collections dc
    where dc.document_id=p_document_id and dc.org_id=p_org_id;
  delete from public.chunks c where c.document_id=p_document_id and c.org_id=p_org_id;
  insert into public.chunks(id,org_id,document_id,parent_id,content,context,metadata,embedding,source_type,data_source_id,collection_ids,intelligence_class,domain,object_id)
    select (c->>'id')::uuid,p_org_id,p_document_id,nullif(c->>'parent_id','')::uuid,c->>'content',c->>'context',coalesce(c->'metadata','{}'::jsonb),
      (c->>'embedding')::vector(1024),doc.source_type,doc.data_source_id,cols,doc.intelligence_class,doc.domain,doc.object_id
    from jsonb_array_elements(p_chunks) c;
  get diagnostics written=row_count;
  return written;
end $$;
revoke all on function public.write_prepared_document_chunks(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.write_prepared_document_chunks(uuid,uuid,jsonb) to service_role;

create or replace function public.replace_document_content(
 p_org_id uuid,p_document_id uuid,p_expected_hash text,p_expected_updated_at timestamptz,p_patch jsonb,p_chunks jsonb
) returns integer language plpgsql security invoker set search_path = public, extensions as $$
declare doc public.documents%rowtype;
begin
  select d.* into doc from public.documents d where d.id=p_document_id and d.org_id=p_org_id for update;
  if doc.id is null then raise exception 'Document not found'; end if;
  if doc.content_hash is distinct from p_expected_hash or doc.updated_at is distinct from p_expected_updated_at then
    raise exception 'Document changed while replacement was prepared; retry from the latest version' using errcode='40001';
  end if;
  if nullif(p_patch->>'content_hash','') is null or jsonb_typeof(p_patch->'metadata') is distinct from 'object' then
    raise exception 'Invalid document metadata';
  end if;
  if p_patch->>'object_id' is not null and not exists(select 1 from public.knowledge_objects k where k.id=(p_patch->>'object_id')::uuid and k.org_id=p_org_id) then
    raise exception 'Invalid object scope';
  end if;
  update public.documents set content_hash=p_patch->>'content_hash',metadata=p_patch->'metadata',updated_at=clock_timestamp(),
    title=case when p_patch ? 'title' then p_patch->>'title' else doc.title end,
    intelligence_class=case when p_patch ? 'intelligence_class' then p_patch->>'intelligence_class' else doc.intelligence_class end,
    domain=case when p_patch ? 'domain' then p_patch->>'domain' else doc.domain end,
    object_id=case when p_patch ? 'object_id' then (p_patch->>'object_id')::uuid else doc.object_id end
    where id=p_document_id and org_id=p_org_id;
  return public.write_prepared_document_chunks(p_org_id,p_document_id,p_chunks);
end $$;
revoke all on function public.replace_document_content(uuid,uuid,text,timestamptz,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.replace_document_content(uuid,uuid,text,timestamptz,jsonb,jsonb) to service_role;

create or replace function public.commit_document_ingestion(
 p_org_id uuid,p_document_id uuid,p_document jsonb,p_chunks jsonb,p_collection_ids uuid[],p_allow_duplicate boolean default false
) returns table(document_id uuid,skipped boolean,chunks integer)
language plpgsql security invoker set search_path = public, extensions as $$
declare doc_id uuid; ds uuid := (p_document->>'data_source_id')::uuid; obj uuid := (p_document->>'object_id')::uuid;
  changed integer; written integer; cols uuid[];
begin
  if p_org_id is null or p_document_id is null or nullif(p_document->>'content_hash','') is null
    or jsonb_typeof(p_document->'metadata') is distinct from 'object' then raise exception 'Invalid document identity'; end if;
  if ds is not null and not exists(select 1 from public.data_sources s where s.id=ds and s.org_id=p_org_id) then raise exception 'Invalid source scope'; end if;
  if obj is not null and not exists(select 1 from public.knowledge_objects k where k.id=obj and k.org_id=p_org_id) then raise exception 'Invalid object scope'; end if;
  if exists(select 1 from unnest(coalesce(p_collection_ids,'{}'::uuid[])) c where not exists(select 1 from public.collections col where col.id=c and col.org_id=p_org_id)) then
    raise exception 'Invalid collection scope';
  end if;
  if not coalesce(p_allow_duplicate,false) then
    perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_org_id,p_document->>'source_type',ds,p_document->>'content_hash',p_document->>'intelligence_class',p_document->>'domain',obj)::text,0));
    select d.id into doc_id from public.documents d where d.org_id=p_org_id and d.source_type=p_document->>'source_type'
      and d.data_source_id is not distinct from ds and d.content_hash=p_document->>'content_hash'
      and d.intelligence_class is not distinct from p_document->>'intelligence_class'
      and d.domain is not distinct from p_document->>'domain' and d.object_id is not distinct from obj
      order by d.created_at,d.id limit 1 for update;
    if doc_id is not null and exists(select 1 from public.chunks c where c.document_id=doc_id and c.org_id=p_org_id) then
      insert into public.document_collections(org_id,document_id,collection_id)
        select p_org_id,doc_id,c from unnest(coalesce(p_collection_ids,'{}'::uuid[])) c on conflict do nothing;
      get diagnostics changed=row_count;
      if changed>0 then
        select coalesce(array_agg(dc.collection_id),'{}'::uuid[]) into cols from public.document_collections dc where dc.document_id=doc_id and dc.org_id=p_org_id;
        update public.chunks set collection_ids=cols where org_id=p_org_id and chunks.document_id=doc_id;
      end if;
      return query select doc_id,true,0; return;
    end if;
  end if;
  -- A null chunk payload is the cheap duplicate preflight, never an empty insert.
  if p_chunks is null then return; end if;
  if doc_id is null then
    doc_id:=p_document_id;
    insert into public.documents(id,org_id,source_type,title,uri,content_hash,metadata,data_source_id,intelligence_class,domain,object_id)
      values(doc_id,p_org_id,p_document->>'source_type',p_document->>'title',p_document->>'uri',p_document->>'content_hash',p_document->'metadata',ds,p_document->>'intelligence_class',p_document->>'domain',obj);
  end if;
  insert into public.document_collections(org_id,document_id,collection_id)
    select p_org_id,doc_id,c from unnest(coalesce(p_collection_ids,'{}'::uuid[])) c on conflict do nothing;
  written:=public.write_prepared_document_chunks(p_org_id,doc_id,p_chunks);
  return query select doc_id,false,written;
end $$;
revoke all on function public.commit_document_ingestion(uuid,uuid,jsonb,jsonb,uuid[],boolean) from public,anon,authenticated;
grant execute on function public.commit_document_ingestion(uuid,uuid,jsonb,jsonb,uuid[],boolean) to service_role;
