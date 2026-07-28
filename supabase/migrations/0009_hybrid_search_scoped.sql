-- 0009_hybrid_search_scoped.sql : scope-aware hybrid retrieval.
--
-- Supersedes 0002's hybrid_search for the API path. Differences:
--   1. Enforces a key's SCOPE: source_types[], data_source_ids[], collection_ids[].
--      An empty array means "no restriction on this dimension".
--   2. Returns only the columns the app needs (no embedding / no fts) — the 1024-dim
--      vector must never travel over the wire.
-- Reciprocal Rank Fusion of full-text + vector, same as before.

create or replace function hybrid_search_scoped(
  p_org_id uuid,
  query_text text,
  query_embedding vector(1024),
  p_source_types text[] default '{}',
  p_data_source_ids uuid[] default '{}',
  p_collection_ids uuid[] default '{}',
  match_count int default 40,
  full_text_weight float default 1.0,
  semantic_weight float default 1.0,
  rrf_k int default 50
)
returns table (
  id uuid,
  document_id uuid,
  parent_id uuid,
  content text,
  metadata jsonb,
  source_type text
)
language sql stable
as $$
with scoped as (
  select c.id, c.document_id, c.parent_id, c.content, c.metadata, c.source_type, c.fts, c.embedding
  from chunks c
  where c.org_id = p_org_id
    and (cardinality(p_source_types)    = 0 or c.source_type    = any(p_source_types))
    and (cardinality(p_data_source_ids) = 0 or c.data_source_id = any(p_data_source_ids))
    and (cardinality(p_collection_ids)  = 0 or c.collection_ids && p_collection_ids)
),
full_text as (
  select id, row_number() over (
           order by ts_rank_cd(fts, websearch_to_tsquery('english', query_text)) desc
         ) as rank_ix
  from scoped
  where fts @@ websearch_to_tsquery('english', query_text)
  order by rank_ix
  limit least(match_count, 200) * 2
),
semantic as (
  select id, row_number() over (order by embedding <=> query_embedding) as rank_ix
  from scoped
  order by rank_ix
  limit least(match_count, 200) * 2
)
select s.id, s.document_id, s.parent_id, s.content, s.metadata, s.source_type
from full_text
full outer join semantic on full_text.id = semantic.id
join scoped s on s.id = coalesce(full_text.id, semantic.id)
order by
  coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
  coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight desc
limit least(match_count, 200);
$$;
