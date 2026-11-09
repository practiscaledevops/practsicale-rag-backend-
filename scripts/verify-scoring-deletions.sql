-- Run inside BEGIN/ROLLBACK. Only disposable UUIDs, no source calls or models.
do $$
declare tenant uuid; source uuid; record uuid:=gen_random_uuid(); meta jsonb; doc_ids uuid[]; n integer;
begin
  select org_id,id into tenant,source from public.data_sources where slug='call-scoring' and is_active limit 1;
  if source is null then raise exception 'Active scoring source required'; end if;
  meta:=jsonb_build_object('source_record_id',record::text,'source_updated_at',now(),'call_status','closed','ticket_category','high_ticket','call_outcome','FOLLOW_UP');
  perform * from public.publish_scoring_metadata(tenant,source,record::text,meta,'Disposable deletion verification','Fictional metadata only');
  select array_agg(id) into doc_ids from public.documents where org_id=tenant and data_source_id=source and metadata->>'source_record_id'=record::text;
  assert cardinality(doc_ids)=2,'Both call identities required before deletion';
  n:=public.delete_scoring_record(tenant,source,record,clock_timestamp());
  assert n=2,'Both call identities must be deleted atomically';
  assert not exists(select 1 from public.chunks where document_id=any(doc_ids)),'Deleted chunks survived';
  assert exists(select 1 from public.scoring_deleted_records where org_id=tenant and data_source_id=source and record_id=record),'Deletion marker missing';
  assert public.delete_scoring_record(tenant,source,record,clock_timestamp())=0,'Deletion replay not idempotent';
  -- Snapshots fetched before deletion, even stamped with a later revision, cannot
  -- recreate the deleted UUID through either ingestion entry point.
  begin
    perform * from public.publish_scoring_metadata(tenant,source,record::text,meta,'Late registration','Late metadata');
    raise exception 'Registration resurrected a deleted call';
  exception when sqlstate 'PT410' then null; end;
  begin
    perform * from public.sync_source_document(tenant,source,'transcript',record::text,'old-hash','Late transcript',meta,'{}'::jsonb,
      jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'content','Fictional old transcript','metadata',meta,'embedding',null)));
    raise exception 'Full ingestion resurrected a deleted call';
  exception when sqlstate 'PT410' then null; end;
  begin
    perform public.delete_scoring_record(gen_random_uuid(),source,record,now());
    raise exception 'Foreign organization accepted';
  exception when others then if sqlerrm='Foreign organization accepted' then raise; end if; end;
  assert not exists(select 1 from public.documents where id=any(doc_ids)),'Deleted documents reappeared';
  assert not has_table_privilege('authenticated','public.scoring_deleted_records','SELECT'),'Browser can read deleted IDs';
  assert not has_function_privilege('anon','public.delete_scoring_record(uuid,uuid,uuid,timestamptz)','EXECUTE'),'Anonymous deletion allowed';
  assert not has_function_privilege('authenticated','public.delete_scoring_record(uuid,uuid,uuid,timestamptz)','EXECUTE'),'Browser deletion allowed';
end $$;
