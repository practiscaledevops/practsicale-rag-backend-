-- SQL-language functions used a generic plan that could not simplify optional
-- scope predicates. Custom plans preserve every filter and use lane/selectivity
-- statistics for the actual request, keeping indexed searches below API timeouts.
select '[1,0]'::extensions.vector <=> '[1,0]'::extensions.vector;
create or replace function public.hybrid_search_lane(
  p_org_id uuid, query_text text, query_embedding vector(1024),
  p_source_types text[] default '{}', p_data_source_ids uuid[] default '{}',
  p_collection_ids uuid[] default '{}', p_classes text[] default '{}',
  p_domains text[] default '{}', p_object_ids uuid[] default '{}',
  match_count int default 40, full_text_weight float default 1.0,
  semantic_weight float default 1.0, rrf_k int default 50
)
returns table(id uuid,document_id uuid,parent_id uuid,content text,metadata jsonb,
 source_type text,object_id uuid,intelligence_class text,domain text,rrf_score float)
language plpgsql stable
set search_path = public, extensions
set hnsw.ef_search = 200
set hnsw.iterative_scan = strict_order
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
 return query
 with scoped as not materialized (
  select c.id,c.document_id,c.parent_id,c.content,c.metadata,c.source_type,
    c.object_id,coalesce(c.intelligence_class,'business_reality') as intelligence_class,
    c.domain,c.fts,c.embedding
  from public.chunks c
  where c.org_id=p_org_id
    and (cardinality(p_source_types)=0 or c.source_type=any(p_source_types))
    and (cardinality(p_data_source_ids)=0 or c.data_source_id=any(p_data_source_ids))
    and (cardinality(p_collection_ids)=0 or c.collection_ids && p_collection_ids)
    and (cardinality(p_classes)=0 or coalesce(c.intelligence_class,'business_reality')=any(p_classes))
    and (cardinality(p_domains)=0 or c.domain=any(p_domains))
    and (cardinality(p_object_ids)=0 or c.object_id=any(p_object_ids))
 ), lexical_candidates as materialized (
  select id,ts_rank_cd(fts,websearch_to_tsquery('english',query_text)) as relevance
  from scoped
  where full_text_weight>0 and fts @@ websearch_to_tsquery('english',query_text)
  order by relevance desc
  limit least(greatest(match_count,0),200)*2
 ), vector_candidates as materialized (
  select id,embedding <=> query_embedding as distance
  from scoped
  where semantic_weight>0 and embedding is not null
  order by embedding <=> query_embedding
  limit least(greatest(match_count,0),200)*2
 ), full_text as (
  select id,row_number() over(order by relevance desc,id) as rank_ix from lexical_candidates
 ), semantic as (
  select id,row_number() over(order by distance,id) as rank_ix from vector_candidates
 ), fused as (
  select coalesce(f.id,s.id) as id,
    (coalesce(1.0/(greatest(rrf_k,1)+f.rank_ix),0.0)*full_text_weight+
     coalesce(1.0/(greatest(rrf_k,1)+s.rank_ix),0.0)*semantic_weight)::float as score
  from full_text f full outer join semantic s on f.id=s.id
  order by score desc,id
  limit least(greatest(match_count,0),200)
 )
 select c.id,c.document_id,c.parent_id,c.content,c.metadata,c.source_type,
   c.object_id,c.intelligence_class,c.domain,f.score
 from fused f join scoped c on c.id=f.id
 order by f.score desc,c.id;
end;
$$;

