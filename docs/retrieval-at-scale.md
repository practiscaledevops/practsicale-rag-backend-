# Retrieval at scale — the HNSW filtered-search fix

**Status: recommended for when the corpus grows large (tens of thousands of chunks per org). Not needed at current scale (~3k chunks). Apply and benchmark in staging before production — this rewrites the core retrieval function.**

## The problem

`hybrid_search_scoped` (migration `0009`) does the vector leg like this:

```sql
with scoped as (            -- org + key-scope filter, materialized
  select ... from chunks c where c.org_id = p_org_id and (...scope...)
),
semantic as (
  select id, row_number() over (order by embedding <=> query_embedding)
  from scoped                -- ← ordering the FILTERED set
  order by rank_ix limit ...
)
```

pgvector's HNSW index (`chunks_embedding_idx`) can only accelerate an
`ORDER BY embedding <=> $1 LIMIT k` applied **directly to the table**. Ordering a
WHERE-filtered CTE forces the planner to compute exact cosine distance for
**every** scoped row and sort them — the ANN index is unused. Fine at demo scale;
at tens/hundreds of thousands of chunks each `/chat` and `/retrieve` call does a
full per-org distance scan and blows the latency budget. This is the classic
pgvector "filtered search + HNSW" trap.

## Prerequisite: pgvector >= 0.8.0

The fix relies on **iterative index scans**, added in pgvector 0.8.0. Check:

```sql
select extversion from pg_extension where extname = 'vector';
```

If it is older than `0.8.0`, upgrade the extension first (Supabase → Database →
Extensions), or do not apply this yet.

## The fix

Run the vector `ORDER BY ... LIMIT` **directly on `chunks`** with the scope filter
inline (not over a materialized CTE), and enable iterative scan so the index keeps
scanning past filtered-out rows until it has enough matches. FTS + Reciprocal Rank
Fusion are unchanged, and the signature + return shape are identical, so it is a
drop-in replacement (rollback = re-run `0009`).

Paste this into the Supabase SQL editor **in staging first**:

```sql
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
  id uuid, document_id uuid, parent_id uuid,
  content text, metadata jsonb, source_type text
)
language plpgsql stable
as $$
begin
  -- Use the HNSW index WITH the scope filter: keep scanning the index until
  -- enough rows pass the WHERE, instead of exact-scanning the filtered set.
  set local hnsw.iterative_scan = 'relaxed_order';
  set local hnsw.ef_search = 100;

  return query
  with full_text as (
    select c.id, row_number() over (
             order by ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) desc
           ) as rank_ix
    from chunks c
    where c.org_id = p_org_id
      and (cardinality(p_source_types)    = 0 or c.source_type    = any(p_source_types))
      and (cardinality(p_data_source_ids) = 0 or c.data_source_id = any(p_data_source_ids))
      and (cardinality(p_collection_ids)  = 0 or c.collection_ids && p_collection_ids)
      and c.fts @@ websearch_to_tsquery('english', query_text)
    order by rank_ix
    limit least(match_count, 200) * 2
  ),
  semantic as (
    -- Vector ORDER BY runs on the base table with the filter inline, so the
    -- HNSW index (chunks_embedding_idx) can be used with iterative scan.
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank_ix
    from chunks c
    where c.org_id = p_org_id
      and (cardinality(p_source_types)    = 0 or c.source_type    = any(p_source_types))
      and (cardinality(p_data_source_ids) = 0 or c.data_source_id = any(p_data_source_ids))
      and (cardinality(p_collection_ids)  = 0 or c.collection_ids && p_collection_ids)
    order by c.embedding <=> query_embedding
    limit least(match_count, 200) * 2
  )
  select s.id, s.document_id, s.parent_id, s.content, s.metadata, s.source_type
  from full_text
  full outer join semantic on full_text.id = semantic.id
  join chunks s on s.id = coalesce(full_text.id, semantic.id)
  order by
    coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
    coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight desc
  limit least(match_count, 200);
end;
$$;
```

Then update `supabase/setup/brain_full.sql` (the consolidated fresh-setup file) to
match, so new environments get the fixed function.

## Verify it actually uses the index

Run the vector leg alone with `EXPLAIN ANALYZE`, before and after, at realistic
row counts:

```sql
explain analyze
select c.id
from chunks c
where c.org_id = '<an org id>'
order by c.embedding <=> '<a real 1024-dim query vector>'
limit 80;
```

- **Before / broken:** a `Seq Scan on chunks` (or a filter + sort) with no index.
- **After / fixed:** an `Index Scan using chunks_embedding_idx` (HNSW). With
  iterative scan you may also see it re-scan; total time should drop sharply as the
  corpus grows.

Tune `hnsw.ef_search` (higher = better recall, slower) and the `iterative_scan`
mode (`relaxed_order` is faster; `strict_order` guarantees exact ordering) against
your own recall/latency targets.

## Rollback

Re-run migration `0009_hybrid_search_scoped.sql` to restore the previous function.
Nothing else references the changed behavior — the app calls the function by the
same name and reads the same columns.

## Notes

- Keep an eye on the `chunks_embedding_idx` build parameters (`m`, `ef_construction`)
  as the corpus grows; a rebuild with higher `ef_construction` improves recall.
- If you shard very large orgs, consider a partial HNSW index per high-volume
  `source_type`, but measure first — a single index with iterative scan is simpler
  and usually enough.
