-- Avoid rewriting already-current source documents and all their chunks.
create or replace function public.sync_source_document(
  p_org_id uuid, p_source_id uuid, p_source_type text, p_record_id text,
  p_content_hash text, p_title text, p_metadata jsonb, p_lane jsonb,
  p_chunks jsonb default null
) returns table(document_id uuid, skipped boolean, chunks integer)
language plpgsql security invoker set search_path = public, extensions as $$
declare
  old_doc public.documents%rowtype;
  doc_id uuid;
  duplicates uuid[];
  cols uuid[];
  old_keys text[];
  chunk_count integer;
  changed boolean;
begin
  if not exists (select 1 from public.data_sources s where s.id=p_source_id and s.org_id=p_org_id and s.source_type='call_score')
    or p_source_type not in ('call_score','transcript') or nullif(p_record_id,'') is null
    or p_metadata->>'source_record_id' is distinct from p_record_id then
    raise exception 'Invalid source identity';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':'||p_source_id::text||':'||p_source_type||':'||p_record_id,0));
  select d.* into old_doc from public.documents d
    where d.org_id=p_org_id and d.data_source_id=p_source_id and d.source_type=p_source_type
      and d.metadata->>'source_record_id'=p_record_id order by d.created_at,d.id limit 1;
  doc_id := old_doc.id;
  if doc_id is not null and old_doc.metadata->>'source_updated_at' is not null
      and p_metadata->>'source_updated_at' is not null
      and (old_doc.metadata->>'source_updated_at')::timestamptz > (p_metadata->>'source_updated_at')::timestamptz then
    return query select doc_id,true,0; return;
  end if;
  select coalesce(array_agg(d.id),'{}'::uuid[]) into duplicates from public.documents d
    where d.org_id=p_org_id and d.data_source_id=p_source_id and d.source_type=p_source_type
      and d.metadata->>'source_record_id'=p_record_id and d.id<>doc_id;
  select coalesce(array_agg(k),'{}'::text[]) into old_keys from jsonb_object_keys(coalesce(old_doc.metadata,'{}')) k;
  changed := doc_id is null or old_doc.content_hash is distinct from p_content_hash
    or old_doc.metadata is distinct from p_metadata or old_doc.title is distinct from p_title or cardinality(duplicates)>0;
  -- Unchanged polling records must be true no-ops. Updating every chunk on
  -- each replay adds write amplification, refresh noise, and index contention.
  -- Keep this check under the same source identity lock as updates/deletions.
  if doc_id is not null and p_chunks is null and not changed
      and old_doc.intelligence_class is not distinct from coalesce(p_lane->>'intelligence_class',old_doc.intelligence_class)
      and old_doc.domain is not distinct from coalesce(p_lane->>'domain',old_doc.domain)
      and exists(select 1 from public.chunks c where c.org_id=p_org_id and c.document_id=doc_id) then
    return query select doc_id,true,0; return;
  end if;
  if doc_id is null then
    if p_chunks is null then raise exception 'Chunks are required for a new document'; end if;
    insert into public.documents(org_id,data_source_id,source_type,title,content_hash,metadata,intelligence_class,domain)
      values(p_org_id,p_source_id,p_source_type,p_title,p_content_hash,p_metadata,p_lane->>'intelligence_class',p_lane->>'domain') returning id into doc_id;
  else
    update public.documents d set title=p_title,content_hash=p_content_hash,metadata=p_metadata,updated_at=now(),
      intelligence_class=coalesce(p_lane->>'intelligence_class',d.intelligence_class),domain=coalesce(p_lane->>'domain',d.domain)
      where d.id=doc_id and d.org_id=p_org_id;
  end if;
  -- Preserve memberships and references when repairing old append-only copies.
  insert into public.document_collections(org_id,document_id,collection_id)
    select p_org_id,doc_id,c.collection_id from public.document_collections c where c.document_id=any(duplicates)
    on conflict do nothing;
  update public.knowledge_objects k set document_id=doc_id where k.org_id=p_org_id and k.document_id=any(duplicates);
  update public.knowledge_objects k set raw_document_id=doc_id where k.org_id=p_org_id and k.raw_document_id=any(duplicates);
  update public.ingestion_runs r set document_id=doc_id where r.org_id=p_org_id and r.document_id=any(duplicates);
  delete from public.documents d where d.org_id=p_org_id and d.id=any(duplicates);
  select coalesce(array_agg(c.collection_id),'{}'::uuid[]) into cols from public.document_collections c where c.document_id=doc_id;
  if p_chunks is null then
    if old_doc.content_hash is distinct from p_content_hash then raise exception 'Changed body requires chunks'; end if;
    update public.chunks c set metadata=(coalesce(c.metadata,'{}')-old_keys)||p_metadata,
      collection_ids=cols where c.org_id=p_org_id and c.document_id=doc_id;
    get diagnostics chunk_count = row_count;
    if chunk_count=0 then raise exception 'Document has no chunks; retry with a complete body'; end if;
    return query select doc_id,not changed,0; return;
  end if;
  if jsonb_typeof(p_chunks)<>'array' or jsonb_array_length(p_chunks)=0 then raise exception 'Empty chunk set'; end if;
  delete from public.chunks c where c.org_id=p_org_id and c.document_id=doc_id;
  insert into public.chunks(id,org_id,document_id,parent_id,content,context,metadata,embedding,source_type,data_source_id,collection_ids,intelligence_class,domain,object_id)
    select (c->>'id')::uuid,p_org_id,doc_id,(c->>'parent_id')::uuid,c->>'content',c->>'context',c->'metadata',
      (c->>'embedding')::vector(1024),p_source_type,p_source_id,cols,p_lane->>'intelligence_class',p_lane->>'domain',(p_lane->>'object_id')::uuid
    from jsonb_array_elements(p_chunks) c;
  get diagnostics chunk_count = row_count;
  return query select doc_id,false,chunk_count;
end $$;
revoke all on function public.sync_source_document(uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.sync_source_document(uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb) to service_role;
