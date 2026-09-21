-- 0017_operating_intelligence.sql — the PractiScale Operating Intelligence System.
--
-- Turns the Brain from a document library into connected institutional memory:
--   • knowledge_objects      — the canonical intelligence object (CLASS → DOMAIN →
--                              TYPE → SUBTYPE, governance, authority, temporal +
--                              provenance metadata, an object-level embedding)
--   • taxonomy_values        — controlled-but-extensible taxonomy + approval queue
--   • knowledge_relationships— the edge table (complements / contradicts /
--                              implemented_in / validated_by / …)
--   • entities + mentions    — WHO and WHAT exist inside the knowledge
--   • learning_records       — the Organizational Learning lifecycle
--                              (decision → implementation → experiment → result →
--                              learning → adaptation → standard)
--   • ingestion_decisions    — every automatic classification decision, inspectable
--   • metrics                — Performance Memory (structured numbers)
--   • chunks/documents       — intelligence_class / domain / object_id denormalised
--                              so retrieval lanes filter inside the database
--   • hybrid_search_lane     — lane-aware hybrid search (RRF) returning object ids
--   • match_knowledge_objects— object-level similarity for dedup + relationships
--
-- Idempotent and non-destructive: safe to run repeatedly on an existing project.
-- All new tables: RLS ON with NO policies = service-role only (the dashboard and
-- the public API read them server-side). Existing rows are back-filled into the
-- Business Reality lane so retrieval keeps working the moment this is applied.

-- ── knowledge_objects ───────────────────────────────────────────────────────
create table if not exists public.knowledge_objects (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.orgs(id) on delete cascade,
  ref                   text not null,                       -- stable human id: MG-001, DEC-014, PI-LI-003
  name                  text not null,
  intelligence_class    text not null check (intelligence_class in
                          ('business_reality','playbook','organizational_learning','platform_intelligence','performance_memory','raw_archive')),
  domain                text not null default 'other',
  object_type           text not null default 'document',
  subtype               text,
  status                text not null default 'active' check (status in ('active','draft','historical','archived')),
  priority              text not null default 'normal' check (priority in ('core','strong','normal','low')),
  founder_endorsement   text check (founder_endorsement is null or founder_endorsement in ('interested','approved','practiscale_standard')),
  implementation_status text not null default 'not_tested' check (implementation_status in ('not_tested','testing','implemented')),
  internal_validation   text not null default 'unvalidated' check (internal_validation in ('unvalidated','validated','modified','rejected')),
  evidence_level        text,
  authority             text not null default 'B3',
  applies_to            text[] not null default '{}',
  goals                 text[] not null default '{}',
  business_functions    text[] not null default '{}',
  applies_to_platforms  text[] not null default '{}',
  tags                  text[] not null default '{}',
  -- content dimensions (content-domain objects)
  content_format        text,
  content_job           text,
  funnel_stage          text,
  brand                 text,
  audiences             text[] not null default '{}',
  content_length        text,
  -- provenance (WHO said it, WHERE, WHEN, WHAT they claimed)
  source_expert         text,
  source_type           text,
  source_platform       text,
  source_url            text,
  source_date           date,
  source_claims         jsonb not null default '[]',          -- [{claim, verified, tested, note}]
  sources               jsonb not null default '[]',          -- every source that fed this object
  -- temporal validity
  effective_from        timestamptz,
  effective_until       timestamptz,
  last_verified_at      timestamptz,
  version               int not null default 1,
  -- the compiled object + its raw source, both retrievable but separately identifiable
  document_id           uuid references public.documents(id) on delete set null,
  raw_document_id       uuid references public.documents(id) on delete set null,
  compiled_markdown     text,
  summary               text,
  attributes            jsonb not null default '{}',
  embedding             vector(1024),
  created_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, ref)
);

create index if not exists knowledge_objects_org_class_domain_idx on public.knowledge_objects (org_id, intelligence_class, domain);
create index if not exists knowledge_objects_org_status_idx       on public.knowledge_objects (org_id, status);
create index if not exists knowledge_objects_org_type_idx         on public.knowledge_objects (org_id, object_type);
create index if not exists knowledge_objects_org_updated_idx      on public.knowledge_objects (org_id, updated_at desc);
create index if not exists knowledge_objects_document_idx         on public.knowledge_objects (document_id);
create index if not exists knowledge_objects_tags_gin             on public.knowledge_objects using gin (tags);
create index if not exists knowledge_objects_embedding_idx        on public.knowledge_objects
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 128);

drop trigger if exists set_updated_at on public.knowledge_objects;
create trigger set_updated_at before update on public.knowledge_objects
  for each row execute function public.set_updated_at();

-- ── taxonomy_values (extensions + proposals; predefined values live in code) ─
create table if not exists public.taxonomy_values (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs(id) on delete cascade,
  kind               text not null check (kind in
                       ('domain','object_type','subtype','platform','format','content_job','funnel_stage','audience','applies_to','business_function','goal','tag')),
  intelligence_class text,
  domain             text,
  object_type        text,
  value              text not null,
  label              text,
  status             text not null default 'approved' check (status in ('approved','proposed','rejected')),
  proposed_by        text not null default 'user' check (proposed_by in ('ai','user','system')),
  usage_count        int not null default 0,
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists taxonomy_values_uidx
  on public.taxonomy_values (org_id, kind, coalesce(domain,''), coalesce(object_type,''), value);
create index if not exists taxonomy_values_org_status_idx on public.taxonomy_values (org_id, status);

drop trigger if exists set_updated_at on public.taxonomy_values;
create trigger set_updated_at before update on public.taxonomy_values
  for each row execute function public.set_updated_at();

-- ── knowledge_relationships (the graph, without a graph database) ───────────
create table if not exists public.knowledge_relationships (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  source_object_id  uuid not null references public.knowledge_objects(id) on delete cascade,
  relationship_type text not null,
  target_object_id  uuid not null references public.knowledge_objects(id) on delete cascade,
  status            text not null default 'confirmed' check (status in ('confirmed','suggested','rejected')),
  confidence        numeric(4,3),
  origin            text not null default 'user' check (origin in ('markdown','system','ai','user')),
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source_object_id, relationship_type, target_object_id)
);
create index if not exists knowledge_relationships_source_idx on public.knowledge_relationships (source_object_id);
create index if not exists knowledge_relationships_target_idx on public.knowledge_relationships (target_object_id);
create index if not exists knowledge_relationships_org_status_idx on public.knowledge_relationships (org_id, status);

drop trigger if exists set_updated_at on public.knowledge_relationships;
create trigger set_updated_at before update on public.knowledge_relationships
  for each row execute function public.set_updated_at();

-- ── entities + entity_mentions ──────────────────────────────────────────────
create table if not exists public.entities (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  kind          text not null,
  name          text not null,
  slug          text not null,
  aliases       text[] not null default '{}',
  attributes    jsonb not null default '{}',
  mention_count int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, kind, slug)
);
create index if not exists entities_org_kind_idx on public.entities (org_id, kind);

drop trigger if exists set_updated_at on public.entities;
create trigger set_updated_at before update on public.entities
  for each row execute function public.set_updated_at();

create table if not exists public.entity_mentions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  entity_id   uuid not null references public.entities(id) on delete cascade,
  object_id   uuid references public.knowledge_objects(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  role        text,                                   -- salesperson | prospect | outcome | objection | department …
  value       text,
  created_at  timestamptz not null default now()
);
create index if not exists entity_mentions_entity_idx   on public.entity_mentions (entity_id);
create index if not exists entity_mentions_object_idx   on public.entity_mentions (object_id);
create index if not exists entity_mentions_document_idx on public.entity_mentions (document_id);
create index if not exists entity_mentions_org_idx      on public.entity_mentions (org_id);

-- ── learning_records (Organizational Learning lifecycle) ────────────────────
create table if not exists public.learning_records (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.orgs(id) on delete cascade,
  object_id             uuid not null unique references public.knowledge_objects(id) on delete cascade,
  record_type           text not null check (record_type in
                          ('decision','implementation','experiment','result','learning','adaptation','postmortem','standard')),
  lifecycle_status      text not null default 'open' check (lifecycle_status in
                          ('proposed','open','implementing','measuring','completed','validated','rejected','archived')),
  department            text,
  owner                 text,
  started_at            timestamptz,
  ended_at              timestamptz,
  changes               jsonb not null default '{}',
  metrics_before        jsonb not null default '{}',
  metrics_after         jsonb not null default '{}',
  confidence            text check (confidence is null or confidence in ('low','medium','high')),
  related_playbook_refs text[] not null default '{}',
  evidence_document_ids uuid[] not null default '{}',
  missing_evidence      text[] not null default '{}',
  parent_record_id      uuid references public.learning_records(id) on delete set null,
  source                text not null default 'manual' check (source in ('chat','manual','auto','ingest')),
  created_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists learning_records_org_type_idx   on public.learning_records (org_id, record_type);
create index if not exists learning_records_org_status_idx on public.learning_records (org_id, lifecycle_status);
create index if not exists learning_records_parent_idx     on public.learning_records (parent_record_id);

drop trigger if exists set_updated_at on public.learning_records;
create trigger set_updated_at before update on public.learning_records
  for each row execute function public.set_updated_at();

-- ── ingestion_decisions (inspectable classification log) ────────────────────
create table if not exists public.ingestion_decisions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  run_id      uuid references public.ingestion_runs(id) on delete set null,
  object_id   uuid references public.knowledge_objects(id) on delete set null,
  stage       text not null,                          -- classify | taxonomy | dedup | compile | entities | relationships | learning
  decision    text not null,                          -- new | enrich | duplicate | conflict | reuse | propose | suggest | …
  input       jsonb not null default '{}',
  output      jsonb not null default '{}',
  model       text,
  confidence  numeric(4,3),
  duration_ms int,
  created_at  timestamptz not null default now()
);
create index if not exists ingestion_decisions_org_created_idx on public.ingestion_decisions (org_id, created_at desc);
create index if not exists ingestion_decisions_object_idx      on public.ingestion_decisions (object_id);

-- ── metrics (Performance Memory) ────────────────────────────────────────────
create table if not exists public.metrics (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  metric_key   text not null,                          -- close_rate | show_rate | profile_visits | …
  label        text,
  entity_id    uuid references public.entities(id) on delete set null,
  dimensions   jsonb not null default '{}',            -- {campaign:'home_health', platform:'linkedin', …}
  period_start date,
  period_end   date,
  value        numeric not null,
  unit         text,
  source       text not null default 'manual',
  object_id    uuid references public.knowledge_objects(id) on delete set null,
  note         text,
  created_by   text,
  created_at   timestamptz not null default now()
);
create index if not exists metrics_org_key_period_idx on public.metrics (org_id, metric_key, period_start desc);
create index if not exists metrics_entity_idx         on public.metrics (entity_id);

-- ── chunks / documents: lane columns (denormalised for in-DB filtering) ─────
alter table public.chunks    add column if not exists intelligence_class text;
alter table public.chunks    add column if not exists domain             text;
alter table public.chunks    add column if not exists object_id          uuid;
alter table public.documents add column if not exists intelligence_class text;
alter table public.documents add column if not exists domain             text;
alter table public.documents add column if not exists object_id          uuid;

create index if not exists chunks_org_class_domain_idx    on public.chunks (org_id, intelligence_class, domain);
create index if not exists chunks_object_idx              on public.chunks (object_id);
create index if not exists documents_org_class_idx        on public.documents (org_id, intelligence_class);
create index if not exists documents_object_idx           on public.documents (object_id);

-- Back-fill EXISTING rows into the Business Reality lane (idempotent: only nulls).
-- Call scores / coaching / transcripts are sales reality; uploaded documents map
-- from the upload classification category to a domain.
update public.documents d
set intelligence_class = 'business_reality',
    domain = case d.source_type
      when 'call_score' then 'sales'
      when 'coaching'   then 'sales'
      when 'transcript' then 'sales'
      else case coalesce(d.metadata->>'category', '')
        when 'CEO mindset / principles'         then 'founder'
        when 'Sales calls'                      then 'sales'
        when 'Call scores'                      then 'sales'
        when 'Sales objections'                 then 'sales'
        when 'Copywriting'                      then 'content'
        when 'Campaign learnings'               then 'marketing'
        when 'Media strategy'                   then 'content'
        when 'SOPs'                             then 'operations'
        when 'Product knowledge'                then 'company'
        when 'Case studies'                     then 'customer'
        when 'Customer research'                then 'customer'
        when 'Competitor intelligence'          then 'marketing'
        when 'Internal announcements'           then 'company'
        when 'Restricted executive knowledge'   then 'founder'
        else 'company'
      end
    end
where d.intelligence_class is null;

update public.chunks c
set intelligence_class = coalesce(d.intelligence_class, 'business_reality'),
    domain = coalesce(d.domain, 'company')
from public.documents d
where c.document_id = d.id and c.intelligence_class is null;

-- ── hybrid_search_lane: lane-aware hybrid search (RRF) ──────────────────────
-- Same shape + safety as hybrid_search_scoped (key scope enforced in the DB,
-- NOT MATERIALIZED so HNSW + GIN stay eligible), plus lane filters:
--   p_classes    — intelligence classes to search ('{}' = all; legacy NULL rows
--                  count as business_reality; raw_archive only when asked)
--   p_domains    — hard domain filter (the orchestrator normally leaves this
--                  empty and BOOSTS by domain in app code — metadata narrows and
--                  boosts, it does not replace semantic retrieval)
--   p_object_ids — restrict to specific objects (relationship expansion)
-- Returns object_id / class / domain + the fused RRF score for app-side boosting.
create or replace function public.hybrid_search_lane(
  p_org_id uuid,
  query_text text,
  query_embedding vector(1024),
  p_source_types text[] default '{}',
  p_data_source_ids uuid[] default '{}',
  p_collection_ids uuid[] default '{}',
  p_classes text[] default '{}',
  p_domains text[] default '{}',
  p_object_ids uuid[] default '{}',
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
  source_type text,
  object_id uuid,
  intelligence_class text,
  domain text,
  rrf_score float
)
language sql
stable
set search_path = public, extensions
set hnsw.ef_search = 200
as $$
  with scoped as not materialized (
    select c.id, c.document_id, c.parent_id, c.content, c.metadata, c.source_type,
           c.object_id, coalesce(c.intelligence_class, 'business_reality') as intelligence_class, c.domain,
           c.fts, c.embedding
    from public.chunks c
    where c.org_id = p_org_id
      and (cardinality(p_source_types)    = 0 or c.source_type    = any(p_source_types))
      and (cardinality(p_data_source_ids) = 0 or c.data_source_id = any(p_data_source_ids))
      and (cardinality(p_collection_ids)  = 0 or c.collection_ids && p_collection_ids)
      and (cardinality(p_classes)         = 0 or coalesce(c.intelligence_class, 'business_reality') = any(p_classes))
      and (cardinality(p_domains)         = 0 or c.domain = any(p_domains))
      and (cardinality(p_object_ids)      = 0 or c.object_id = any(p_object_ids))
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
  select s.id, s.document_id, s.parent_id, s.content, s.metadata, s.source_type,
         s.object_id, s.intelligence_class, s.domain,
         (coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
          coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight)::float as rrf_score
  from full_text
  full outer join semantic on full_text.id = semantic.id
  join scoped s on s.id = coalesce(full_text.id, semantic.id)
  order by rrf_score desc
  limit least(match_count, 200);
$$;

-- ── match_knowledge_objects: object-level similarity (dedup + relationships) ─
create or replace function public.match_knowledge_objects(
  p_org_id uuid,
  query_embedding vector(1024),
  p_classes text[] default '{}',
  p_domains text[] default '{}',
  match_count int default 8
)
returns table (
  id uuid,
  ref text,
  name text,
  intelligence_class text,
  domain text,
  object_type text,
  subtype text,
  summary text,
  similarity float
)
language sql
stable
set search_path = public, extensions
set hnsw.ef_search = 100
as $$
  select o.id, o.ref, o.name, o.intelligence_class, o.domain, o.object_type, o.subtype, o.summary,
         (1 - (o.embedding <=> query_embedding))::float as similarity
  from public.knowledge_objects o
  where o.org_id = p_org_id
    and o.embedding is not null
    and o.status <> 'archived'
    and (cardinality(p_classes) = 0 or o.intelligence_class = any(p_classes))
    and (cardinality(p_domains) = 0 or o.domain = any(p_domains))
  order by o.embedding <=> query_embedding
  limit least(match_count, 50);
$$;

-- ── RLS + grants: service-role only (defense in depth; app never uses `authenticated` for data) ─
alter table public.knowledge_objects       enable row level security;
alter table public.knowledge_objects       force  row level security;
alter table public.taxonomy_values         enable row level security;
alter table public.taxonomy_values         force  row level security;
alter table public.knowledge_relationships enable row level security;
alter table public.knowledge_relationships force  row level security;
alter table public.entities                enable row level security;
alter table public.entities                force  row level security;
alter table public.entity_mentions         enable row level security;
alter table public.entity_mentions         force  row level security;
alter table public.learning_records        enable row level security;
alter table public.learning_records        force  row level security;
alter table public.ingestion_decisions     enable row level security;
alter table public.ingestion_decisions     force  row level security;
alter table public.metrics                 enable row level security;
alter table public.metrics                 force  row level security;

revoke select, insert, update, delete on
  public.knowledge_objects, public.taxonomy_values, public.knowledge_relationships,
  public.entities, public.entity_mentions, public.learning_records,
  public.ingestion_decisions, public.metrics
from authenticated, anon;

grant all on
  public.knowledge_objects, public.taxonomy_values, public.knowledge_relationships,
  public.entities, public.entity_mentions, public.learning_records,
  public.ingestion_decisions, public.metrics
to service_role;

grant execute on function
  public.hybrid_search_lane(uuid, text, vector, text[], uuid[], uuid[], text[], text[], uuid[], int, float, float, int),
  public.match_knowledge_objects(uuid, vector, text[], text[], int)
to authenticated, service_role;
revoke execute on function
  public.hybrid_search_lane(uuid, text, vector, text[], uuid[], uuid[], text[], text[], uuid[], int, float, float, int),
  public.match_knowledge_objects(uuid, vector, text[], text[], int)
from anon, public;

comment on table public.knowledge_objects       is 'Canonical intelligence objects: CLASS → DOMAIN → TYPE → SUBTYPE with governance (endorsement/implementation/validation), authority, temporal validity and provenance. document_id = the compiled, chunked, embedded markdown; raw_document_id = the original source.';
comment on table public.knowledge_relationships is 'Generic edge table (source → relationship_type → target). Suggested edges await human confirmation.';
comment on table public.learning_records        is 'Organizational Learning lifecycle: decision → implementation → experiment → result → learning → adaptation → PractiScale standard. One row per learning object.';
comment on table public.ingestion_decisions     is 'Audit log of every automatic classification / dedup / taxonomy / relationship decision the compiler made.';
comment on column public.chunks.intelligence_class is 'Retrieval lane (business_reality | playbook | organizational_learning | platform_intelligence | performance_memory | raw_archive). NULL = legacy = business_reality.';
