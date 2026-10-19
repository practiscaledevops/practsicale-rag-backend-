-- Run against the Brain database after migration 0021. Everything rolls back.
begin;
do $$
declare
  s public.data_sources%rowtype;
  rid text := gen_random_uuid()::text;
  cid uuid := gen_random_uuid();
  doc uuid;
  result record;
  m jsonb;
  body jsonb;
  lane jsonb := '{"intelligence_class":"business_reality","domain":"sales"}';
  failed boolean := false;
begin
  select * into strict s from public.data_sources where source_type='call_score' and is_active limit 1;
  m := jsonb_build_object('source_record_id',rid,'call_status',null,'ticket_category',null,'source_updated_at','2026-10-19T10:00:00Z');
  body := jsonb_build_array(jsonb_build_object('id',cid,'content','Synthetic sync verification: Pending','metadata',m));
  select * into result from public.sync_source_document(s.org_id,s.id,'call_score',rid,'pending-hash','Sync verification',m,lane,body);
  doc := result.document_id;
  assert not result.skipped and result.chunks=1, 'Initial call not inserted';
  select * into result from public.sync_source_document(s.org_id,s.id,'call_score',rid,'pending-hash','Sync verification',m,lane,null);
  assert result.skipped and result.document_id=doc, 'Replay must keep document identity';
  m := m || '{"call_status":"closed","ticket_category":"high_ticket","source_updated_at":"2026-10-19T11:00:00Z"}';
  body := jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'content','Synthetic sync verification: Closed, High Ticket','metadata',m));
  select * into result from public.sync_source_document(s.org_id,s.id,'call_score',rid,'closed-hash','Sync verification',m,lane,body);
  assert result.document_id=doc and not result.skipped, 'Status update must replace the same document';
  assert (select count(*)=1 from public.chunks where document_id=doc), 'Old chunks must be replaced';
  -- A delayed older delivery cannot regress the current status.
  select * into result from public.sync_source_document(s.org_id,s.id,'call_score',rid,'old-hash','Sync verification',m||'{"call_status":"pending","source_updated_at":"2026-10-19T09:00:00Z"}',lane,body);
  assert result.skipped, 'Stale revision was not ignored';
  assert (select metadata->>'call_status'='closed' from public.documents where id=doc), 'Status regressed';
  -- A failed replacement must roll back the document and chunk deletion together.
  begin
    perform public.sync_source_document(s.org_id,s.id,'call_score',rid,'broken-hash','Sync verification',m,lane,
      '[{"id":"invalid-uuid","content":"Must never persist"}]');
  exception when invalid_text_representation then failed := true;
  end;
  assert failed, 'Invalid chunks unexpectedly accepted';
  assert (select content_hash='closed-hash' from public.documents where id=doc), 'Failed replacement changed the document';
  assert (select content like '%Closed%' from public.chunks where document_id=doc), 'Failed replacement removed valid chunks';
  -- A source field being cleared must also disappear from every chunk.
  m := m || '{"call_status":null,"ticket_category":null,"source_updated_at":"2026-10-19T12:00:00Z"}';
  select * into result from public.sync_source_document(s.org_id,s.id,'call_score',rid,'closed-hash','Sync verification',m,lane,null);
  assert (select metadata->>'call_status' is null and metadata->>'ticket_category' is null from public.chunks where document_id=doc), 'Cleared metadata was sticky';
  -- Repair an old append-only copy without changing the canonical identity.
  insert into public.documents(org_id,data_source_id,source_type,content_hash,metadata,created_at)
    values(s.org_id,s.id,'call_score','duplicate-hash',m,now()+interval '1 second');
  select * into result from public.sync_source_document(s.org_id,s.id,'call_score',rid,'closed-hash','Sync verification',m,lane,null);
  assert result.document_id=doc, 'Duplicate repair changed canonical identity';
  assert (select count(*)=1 from public.documents where org_id=s.org_id and data_source_id=s.id and source_type='call_score' and metadata->>'source_record_id'=rid), 'Duplicate was not repaired';
  assert not has_function_privilege('authenticated','public.sync_source_document(uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb)','EXECUTE'), 'Authenticated users can write source records';
end $$;
rollback;
select 'Brain source refresh checks passed; all test changes rolled back' as result;
