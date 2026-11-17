-- Run on the Sales Payroll project, never on Brain's database.
create or replace function public.brain_monthly_sales_closings(p_month date,p_through date)
returns table(closings bigint,usd_minor text,high_ticket bigint,low_ticket bigint,high_usd_minor text,low_usd_minor text)
language sql stable security invoker set search_path='' as $$
with forms as (
  select f.id, f.contact_id, f.submitted_at, f.research_closing_amount as amount,
    case when f.ticket_type in ('high_ticket','low_ticket') then f.ticket_type
      when exists (select 1 from public.employees e where e.ghl_user_id=f.consultant_id_clean and e.ticket_scope='ht') then 'high_ticket'
      else 'low_ticket' end as ticket
  from public.form_claims f
  where f.research_closing_amount > 0 and f.voided_at is null and nullif(f.contact_id,'') is not null
    and f.ht_part is distinct from 'part_1'
    and f.submitted_at >= (p_month::timestamp at time zone 'UTC')
    and f.submitted_at < ((p_through+1)::timestamp at time zone 'UTC')
    and not exists (select 1 from public.closing_entries x where x.supersedes_claim_id=f.id and x.voided_at is null)
), winners as (
  select distinct on (contact_id,ticket) contact_id,ticket,amount
  from forms order by contact_id,ticket,submitted_at desc,id desc
), entries as (
  select contact_id,case when ticket_type='high_ticket' then 'high_ticket' else 'low_ticket' end as ticket,usd_minor as amount,
    coalesce(closed_on,case when to_char(created_at at time zone 'UTC','YYYY-MM')=month then (created_at at time zone 'UTC')::date else p_month end) as effective_day
  from public.closing_entries where month=to_char(p_month,'YYYY-MM') and voided_at is null
), sales as (
  select ticket,amount from entries where effective_day<=p_through
  union all
  select w.ticket,w.amount from winners w where not exists
    (select 1 from entries e where e.contact_id=w.contact_id and e.ticket=w.ticket)
)
select count(*) as closings, coalesce(sum(amount),0)::text as usd_minor,
  count(*) filter(where ticket='high_ticket') as high_ticket,
  count(*) filter(where ticket='low_ticket') as low_ticket,
  coalesce(sum(amount) filter(where ticket='high_ticket'),0)::text as high_usd_minor,
  coalesce(sum(amount) filter(where ticket='low_ticket'),0)::text as low_usd_minor
from sales
having extract(day from p_month)=1 and p_through>=p_month
  and p_through < (p_month+interval '1 month')::date
$$;
revoke execute on function public.brain_monthly_sales_closings(date,date) from public,anon,authenticated;
grant execute on function public.brain_monthly_sales_closings(date,date) to service_role;
