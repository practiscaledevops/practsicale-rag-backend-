-- Entity merge in ONE transaction.
--
-- POST /api/admin/knowledge/entities { action: "merge" } folds entities into a
-- target: their mentions and metrics move to it, exact duplicate mentions are
-- dropped, the target absorbs names / attributes / mention counts, and the
-- merged entities are deleted. Run as separate statements, a failure between
-- them left half a merge behind, and "Retry failed" then added the sources'
-- mention counts to the target a second time. Here every step commits or none
-- does, and the counts added are those of the entities actually deleted.
--
-- The route falls back to its step-by-step path until this is applied.
-- Run once in Supabase (SQL editor) or via the CLI.

create or replace function public.merge_entities(
  p_org uuid,
  p_target uuid,
  p_ids uuid[],
  p_aliases text[],
  p_attributes jsonb
)
returns table (merged uuid[], mentions_moved int, entity jsonb)
language plpgsql
set search_path = public
as $$
declare
  v_ids    uuid[];
  v_moved  int := 0;
  v_merged uuid[] := '{}';
  v_sum    int := 0;
  v_entity jsonb;
begin
  -- The target, locked for the rest of the transaction.
  perform 1 from public.entities e where e.org_id = p_org and e.id = p_target for update;
  if not found then
    raise exception 'Target entity not found' using errcode = 'P0002';
  end if;

  -- The sources that still exist in this org (never the target), locked too.
  select coalesce(array_agg(s.id), '{}') into v_ids
  from (
    select e.id from public.entities e
    where e.org_id = p_org and e.id = any(p_ids) and e.id <> p_target
    for update
  ) s;

  if cardinality(v_ids) > 0 then
    -- 1. Mentions → target (entity_mentions has no unique index, so nothing collides).
    update public.entity_mentions m set entity_id = p_target
     where m.org_id = p_org and m.entity_id = any(v_ids);
    get diagnostics v_moved = row_count;

    -- 2. Metrics linked to a merged entity follow it.
    update public.metrics k set entity_id = p_target
     where k.org_id = p_org and k.entity_id = any(v_ids);

    -- 3. Exact duplicate mentions now on the target (same object / document,
    --    role and value) go; the earliest row per key is kept.
    if v_moved > 0 then
      delete from public.entity_mentions m
      using (
        select x.id,
               row_number() over (
                 partition by coalesce(x.object_id::text, ''), coalesce(x.document_id::text, ''),
                              lower(coalesce(x.role, '')), lower(trim(coalesce(x.value, '')))
                 order by x.created_at, x.id
               ) as rn
        from public.entity_mentions x
        where x.org_id = p_org and x.entity_id = p_target
      ) d
      where m.id = d.id and d.rn > 1;
    end if;

    -- 4. The merged entities go. Their counts are summed over the rows deleted
    --    HERE, so a retried merge can never add them twice.
    with gone as (
      delete from public.entities e
       where e.org_id = p_org and e.id = any(v_ids)
      returning e.id, e.mention_count
    )
    select coalesce(array_agg(g.id), '{}'), coalesce(sum(g.mention_count), 0)::int
      into v_merged, v_sum
      from gone g;
  end if;

  -- 5. The target absorbs names, attributes and mention counts (only when
  --    something was merged into it).
  if cardinality(v_merged) > 0 then
    update public.entities e
       set aliases = coalesce(p_aliases, e.aliases),
           attributes = coalesce(p_attributes, e.attributes),
           mention_count = e.mention_count + v_sum
     where e.org_id = p_org and e.id = p_target
    returning to_jsonb(e.*) into v_entity;
  else
    select to_jsonb(e.*) into v_entity from public.entities e where e.org_id = p_org and e.id = p_target;
  end if;

  return query select v_merged, v_moved, v_entity;
end;
$$;

-- Service role only (the admin API); never callable by browser sessions.
revoke execute on function public.merge_entities(uuid, uuid, uuid[], text[], jsonb) from public, anon, authenticated;
grant execute on function public.merge_entities(uuid, uuid, uuid[], text[], jsonb) to service_role;

comment on function public.merge_entities(uuid, uuid, uuid[], text[], jsonb) is
  'Fold p_ids entities into p_target in one transaction (mentions, metrics, duplicate mentions, aliases, attributes, mention counts, delete). Used by POST /api/admin/knowledge/entities.';
