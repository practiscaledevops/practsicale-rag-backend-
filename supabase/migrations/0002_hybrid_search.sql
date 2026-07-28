-- 0002_hybrid_search.sql : Reciprocal Rank Fusion of vector + full text search

create or replace function hybrid_search(
  p_org_id uuid,
  query_text text,
  query_embedding vector(1024),
  match_count int default 40,
  full_text_weight float default 1.0,
  semantic_weight float default 1.0,
  rrf_k int default 50,
  filter_source_type text default null
)
returns setof chunks
language sql
as $$
with full_text as (
  select id, row_number() over (order by ts_rank_cd(fts, websearch_to_tsquery('english', query_text)) desc) as rank_ix
  from chunks
  where org_id = p_org_id
    and (filter_source_type is null or metadata->>'source_type' = filter_source_type)
    and fts @@ websearch_to_tsquery('english', query_text)
  order by rank_ix
  limit least(match_count, 200) * 2
),
semantic as (
  select id, row_number() over (order by embedding <=> query_embedding) as rank_ix
  from chunks
  where org_id = p_org_id
    and (filter_source_type is null or metadata->>'source_type' = filter_source_type)
  order by rank_ix
  limit least(match_count, 200) * 2
)
select c.*
from full_text
full outer join semantic on full_text.id = semantic.id
join chunks c on c.id = coalesce(full_text.id, semantic.id)
order by
  coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
  coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight desc
limit least(match_count, 200);
$$;
