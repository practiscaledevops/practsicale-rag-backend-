-- Match the nullable legacy-class expression used by retrieval and collect
-- its distribution so the dominant reality lane chooses HNSW, not a full sort.
create index if not exists chunks_org_effective_class_idx on public.chunks (org_id, (coalesce(intelligence_class,'business_reality')));
analyze public.chunks;

