-- Bulk imports can give hundreds of calls an identical updated_at. Persist the
-- last fully processed ID as well, so a bounded run can resume inside that group.
alter table public.data_sources add column if not exists cursor_record_id text;

create or replace function public.advance_scoring_cursor(
  p_org_id uuid, p_source_id uuid, p_cursor_value text, p_record_id text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare source_row public.data_sources%rowtype;
begin
  if p_cursor_value is null or p_record_id is null or p_record_id !~ '^[0-9a-fA-F-]{36}$' then
    raise exception 'A complete scoring cursor is required';
  end if;
  select * into source_row from public.data_sources
    where id = p_source_id and org_id = p_org_id and source_type = 'call_score' and cursor_field = 'updated_at'
    for update;
  if not found then raise exception 'Scoring source unavailable'; end if;
  -- The row lock and monotonic comparison prevent an older concurrent batch
  -- from rewinding a newer batch's checkpoint. Timestamp casts keep microseconds.
  if source_row.cursor_value is null
     or p_cursor_value::timestamptz > source_row.cursor_value::timestamptz
     or (p_cursor_value::timestamptz = source_row.cursor_value::timestamptz
         and p_record_id > coalesce(source_row.cursor_record_id, '')) then
    update public.data_sources set cursor_value = p_cursor_value, cursor_record_id = p_record_id
      where id = p_source_id and org_id = p_org_id;
  end if;
  update public.data_sources set last_run_at = now(), last_status = 'success', updated_at = now()
    where id = p_source_id and org_id = p_org_id;
  return (select jsonb_build_object('cursor_value', cursor_value, 'cursor_record_id', cursor_record_id)
    from public.data_sources where id = p_source_id and org_id = p_org_id);
end;
$$;
revoke all on function public.advance_scoring_cursor(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.advance_scoring_cursor(uuid, uuid, text, text) to service_role;
