
create table public.appointment_report_snapshots (
 scope_key text primary key, location_id text not null,
 lease_id uuid, lease_until timestamptz,
 window_start timestamptz, window_end timestamptz,
 scan_started_at timestamptz, verified_at timestamptz,
 events jsonb, calendars integer, last_failure_at timestamptz,
 check(events is null or jsonb_typeof(events)='array')
);
alter table public.appointment_report_snapshots enable row level security;
revoke all on public.appointment_report_snapshots from public, anon, authenticated;
grant all on public.appointment_report_snapshots to service_role;
create function public.claim_appointment_snapshot(k text, loc text, owner uuid) returns boolean
language plpgsql security invoker set search_path=public as $$
declare n integer;
begin
 insert into appointment_report_snapshots(scope_key,location_id,lease_id,lease_until)
 values(k,loc,owner,now()+interval '5 minutes')
 on conflict(scope_key) do update set lease_id=owner,lease_until=now()+interval '5 minutes'
 where appointment_report_snapshots.lease_until is null or appointment_report_snapshots.lease_until<now();
 get diagnostics n=row_count;return n=1;
end $$;
create function public.publish_appointment_snapshot(k text, owner uuid, ws timestamptz, we timestamptz, started timestamptz, rows_json jsonb, calendar_count integer) returns boolean
language plpgsql security invoker set search_path=public as $$
declare n integer;
begin
 if ws>=we or jsonb_typeof(rows_json)<>'array' or calendar_count<0 then raise exception 'Invalid snapshot';end if;
 update appointment_report_snapshots set window_start=ws,window_end=we,scan_started_at=started,verified_at=clock_timestamp(),
 events=rows_json,calendars=calendar_count,last_failure_at=null,lease_until=null,lease_id=null
 where scope_key=k and lease_id=owner and lease_until>now();
 get diagnostics n=row_count;return n=1;
end $$;
create function public.read_appointment_snapshot(loc text, ws timestamptz, we timestamptz) returns jsonb
language sql stable security invoker set search_path=public as $$
 select jsonb_build_object('verifiedAt',s.verified_at,'scanStartedAt',s.scan_started_at,'lastFailureAt',s.last_failure_at,'calendars',s.calendars,
 'total', count(e),'showed', count(e) filter(where e->>'appointmentStatus'='showed'),
 'noshow',count(e) filter(where e->>'appointmentStatus'='noshow'),
 'cancelled',count(e) filter(where e->>'appointmentStatus' in ('cancelled','canceled')),
 'invalid',count(e) filter(where e->>'appointmentStatus'='invalid'))
 from (select * from appointment_report_snapshots where location_id=loc and window_start<=ws and window_end>=we and verified_at is not null
 order by scan_started_at desc limit 1) s
 left join lateral (select value e from jsonb_array_elements(s.events)
 where (value->>'startTime')::timestamptz>=ws and (value->>'startTime')::timestamptz<we) a on true
 group by s.scope_key,s.verified_at,s.scan_started_at,s.last_failure_at,s.calendars;
$$;
revoke all on function public.claim_appointment_snapshot(text,text,uuid) from public,anon,authenticated;
revoke all on function public.publish_appointment_snapshot(text,uuid,timestamptz,timestamptz,timestamptz,jsonb,integer) from public,anon,authenticated;
revoke all on function public.read_appointment_snapshot(text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_appointment_snapshot(text,text,uuid) to service_role;
grant execute on function public.publish_appointment_snapshot(text,uuid,timestamptz,timestamptz,timestamptz,jsonb,integer) to service_role;
grant execute on function public.read_appointment_snapshot(text,timestamptz,timestamptz) to service_role;

