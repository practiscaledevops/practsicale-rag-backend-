-- Transactional regression test. Append to the migration inside BEGIN/ROLLBACK
-- or run against its installed function; no source calls are written.
do $$
declare
  tenant uuid; source uuid; test_record text := 'registration-verification-'||gen_random_uuid()::text;
  meta jsonb; ids uuid[]; score_doc uuid; transcript_doc uuid; n integer;
  old_revision text := '2026-10-20T13:00:00Z'; newer_revision text := '2026-10-20T13:01:00Z';
begin
  select s.org_id,s.id into tenant,source from public.data_sources s where s.slug='call-scoring' and s.source_type='call_score' and s.is_active limit 1;
  if source is null then raise exception 'Active scoring source required'; end if;
  meta := jsonb_build_object('source_record_id',test_record,'source_updated_at',old_revision,'call_status',null,'ticket_category','low_ticket','call_outcome','FOLLOW_UP','call_sequence',1,'overall_score',20);
  perform * from public.publish_scoring_metadata(tenant,source,test_record,meta,'Registration verification','Metadata only. Transcript analysis not ready.');
  select array_agg(d.id),max(d.id::text) filter(where d.source_type='call_score')::uuid,max(d.id::text) filter(where d.source_type='transcript')::uuid
    into ids,score_doc,transcript_doc from public.documents d where d.org_id=tenant and d.data_source_id=source and d.metadata->>'source_record_id'=test_record;
  if cardinality(ids)<>2 then raise exception 'New call must register both identities'; end if;
  if exists(select 1 from public.documents d where d.id=any(ids) and (d.metadata->>'source_body_updated_at' is not null or d.metadata->>'source_index_state'<>'pending')) then raise exception 'Shell falsely claims complete indexing'; end if;
  select count(*) into n from public.chunks c where c.document_id=score_doc and c.embedding is null and c.metadata->>'registration_summary'='true' and c.fts is not null;
  if n<>1 or exists(select 1 from public.chunks c where c.document_id=transcript_doc) then raise exception 'Expected searchable facts and no fabricated transcript'; end if;
  -- Replay is idempotent; an immediate status update retains the same shells.
  perform * from public.publish_scoring_metadata(tenant,source,test_record,meta,'Registration verification','Metadata only.');
  meta := meta||jsonb_build_object('source_updated_at',newer_revision,'call_status','closed','ticket_category','high_ticket');
  perform * from public.publish_scoring_metadata(tenant,source,test_record,meta,'Registration verification','Metadata only.');
  if (select count(*) from public.documents d where d.id=any(ids) and d.metadata->>'call_status'='closed' and d.metadata->>'ticket_category'='high_ticket')<>2 then raise exception 'Pending call update did not propagate'; end if;
  -- Late older deliveries cannot restore Pending or Low Ticket.
  perform * from public.publish_scoring_metadata(tenant,source,test_record,meta||jsonb_build_object('source_updated_at',old_revision,'call_status',null,'ticket_category','low_ticket'),'Older','Older');
  if (select count(*) from public.documents d where d.id=any(ids) and d.metadata->>'call_status'='closed')<>2 then raise exception 'Stale registration overwrote newer truth'; end if;
  -- The ordinary atomic full worker upgrades the existing document in place.
  meta := meta||jsonb_build_object('source_body_updated_at',newer_revision,'source_index_state','ready');
  perform * from public.sync_source_document(tenant,source,'call_score',test_record,'verified-body','Canonical report',meta,jsonb_build_object('intelligence_class','business_reality','domain','sales'),
    jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'content','Canonical full report','metadata',meta,'embedding',null)));
  perform * from public.publish_scoring_metadata(tenant,source,test_record,meta,'Canonical report','Registration replay must never replace this body');
  if not exists(select 1 from public.documents d where d.id=score_doc and d.content_hash='verified-body' and d.metadata->>'source_index_state'='ready') then raise exception 'Replay replaced a fully indexed document'; end if;
  if not exists(select 1 from public.chunks c where c.document_id=score_doc and c.content='Canonical full report' and c.metadata->>'registration_summary' is null) then raise exception 'Full worker did not replace summary'; end if;
  -- Source/tenant spoofing fails without leaving a shell.
  begin
    perform * from public.publish_scoring_metadata(gen_random_uuid(),source,test_record,meta,'Foreign','Foreign');
    raise exception 'Foreign source accepted';
  exception when others then if sqlerrm='Foreign source accepted' then raise; end if; end;
  if has_function_privilege('anon','public.publish_scoring_metadata(uuid,uuid,text,jsonb,text,text)','execute') or has_function_privilege('authenticated','public.publish_scoring_metadata(uuid,uuid,text,jsonb,text,text)','execute') then raise exception 'Registration exposed to browser roles'; end if;
  if (select count(*) from public.documents d where d.org_id=tenant and d.data_source_id=source and d.metadata->>'source_record_id'=test_record)<>2 then raise exception 'Duplicate call identities'; end if;
  raise notice 'New call registration, replay, status changes, stale protection, body upgrade and permissions passed';
end $$;
