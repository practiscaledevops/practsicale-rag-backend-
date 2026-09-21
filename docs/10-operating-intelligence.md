# 10 — The Operating Intelligence System

The Brain is no longer a document library. It is connected institutional memory
built from **three core intelligence classes** plus two supporting systems, with
one universal taxonomy, an AI ingestion agent, a graph of relationships, and a
retrieval orchestrator that reasons across all of it.

```
                        AI BRAIN
                           │
       ┌───────────────────┼───────────────────┐
  BUSINESS REALITY      PLAYBOOKS       ORGANIZATIONAL LEARNING
  "What is true?"   "What should work?"   "What worked for us?"
       └───────────────────┼───────────────────┘
                     RETRIEVAL ORCHESTRATOR
        (intent → lanes → boosts → relationships → rerank)
                           │
              PLATFORM INTELLIGENCE · PERFORMANCE MEMORY
                           │
                       WORK MODE  (Auto by default)
                     CREATE · ADVISE · BUILD
```

## 1. Taxonomy — `src/lib/intelligence-taxonomy.ts`

`CLASS → DOMAIN → TYPE → SUBTYPE (+ open tags)`

| Level | Rule |
| --- | --- |
| Class | `business_reality` · `playbook` · `organizational_learning` · `platform_intelligence` · `performance_memory` (+ `raw_archive`) |
| Domain | Predefined (`DOMAINS`): what the knowledge is **about** — never where it was found. Each has a ref prefix (`MG`, `SAL`, `CON` …). |
| Type | Predefined per class (`OBJECT_TYPES`). Content-specialised playbook types (hook, story_mechanic …) only for `domain=content`. |
| Subtype | Controlled but extensible: seed values in `SUGGESTED_SUBTYPES`; the compiler reuses (fuzzy `reconcileValue`) or proposes into `taxonomy_values` (approval queue). |

Business Reality buckets (Company Truth, Founder Brain, …) are **derived** from
domain + type + status (`realityBucketOf`) so they never become a second
competing taxonomy.

Governance is three separate questions: **founder_endorsement** (interested →
approved → practiscale_standard), **implementation_status** (not_tested →
testing → implemented), **internal_validation** (unvalidated → validated |
modified | rejected). **Authority** (A1…C3) says what to trust when sources
conflict (`defaultAuthority`); **temporal fields** (`effective_from/until`,
`last_verified_at`, `status`) say whether it is still current (`isCurrent`).
**Provenance** (source expert/type/platform/url/date + `source_claims` +
`sources[]`) keeps "someone taught this" separate from "this is proven".

## 2. Data model — `supabase/migrations/0017_operating_intelligence.sql`

| Table | Purpose |
| --- | --- |
| `knowledge_objects` | The canonical object: taxonomy, governance, authority, temporal, provenance, content dimensions, `compiled_markdown`, `document_id` (compiled + chunked), `raw_document_id` (original), object-level `embedding` (dedup). Stable `ref` (MG-001, DEC-014, PI-LI-003). |
| `taxonomy_values` | Extensions + proposals (`status` approved/proposed/rejected, `usage_count`). |
| `knowledge_relationships` | `source → relationship_type → target` (complements, contradicts, implemented_in, validated_by, used_playbook, adapted_into …) with `status` confirmed/suggested/rejected and `origin` markdown/system/ai/user. |
| `entities` + `entity_mentions` | WHO/WHAT inside the knowledge (person, department, client, offer, campaign, platform, framework, kpi …). |
| `learning_records` | The lifecycle: decision → implementation → experiment → result → learning → adaptation → standard (+ postmortem), with department/owner, metrics before/after, evidence documents, missing evidence, parent chain. |
| `ingestion_decisions` | Every automatic decision (classify / taxonomy / dedup / compile / entities / relationships / learning / guard / persist), inspectable. |
| `metrics` | Performance Memory: `metric_key`, period, value, unit, dimensions, linked object. |
| `chunks.intelligence_class/domain/object_id` | Denormalised lane columns so retrieval filters in SQL (`hybrid_search_lane`). Existing rows are back-filled into the Business Reality lane. |

RPCs: `hybrid_search_lane(...)` (scope + lane filters, RRF, returns object ids +
score) and `match_knowledge_objects(...)` (object-level cosine similarity).

## 3. The Knowledge Compiler — `src/lib/knowledge-compiler.ts`

"Give the Brain information → tell it what class it is → the Brain organizes
itself."

```
raw source + CLASS (+ bucket)
  → classify   structured LLM: name, summary, teaching_core (noise removed),
                domain/type/subtype, applies_to, goals, platforms, tags, content
                dims, source, source_claims, entities, effective dates
  → taxonomy   reuse predefined + approved; propose new subtypes (queue)
  → dedup      object embedding → match_knowledge_objects → judge:
                NEW / ENRICH (append additions, re-chunk) / DUPLICATE (provenance
                only) / CONFLICT (new + `contradicts` both ways)
  → compile    canonical Markdown sections per class template
                (Definition · Problem It Solves · Core Principle · Framework ·
                 How To Apply · Diagnostic · Examples · Failure Modes ·
                 Guardrails · AI Retrieval Instructions · Source Teaching ·
                 Source Claims)
  → persist    knowledge_objects row → compiled document (semantic chunking by
                heading, every chunk inherits the object identity + a
                deterministic context line) → raw_archive document (playbooks)
                → object embedding → entities → relationships (markdown /
                system / AI-suggested) → learning_records → decision log
```

Modes: `preview` (nothing written, for the review screen) and `commit`
(optionally from a reviewed preview with human `overrides`). Guard: an
external (social/expert) source cannot establish **Company Truth** without an
explicit confirmation. Every AI stage has a deterministic fallback.

Prompts (editable in the Prompt Studio): `knowledge_classify`,
`knowledge_compile`, `dedup_judge`. Settings: `intelligence.dedupThreshold`,
`suggestThreshold`, `taxonomyAutoApprove`, `classifyTier`, `compileTier`.

Bulk: `npm run compile:knowledge -- <dir> --class playbook [--dry]`.

## 4. The Retrieval Orchestrator — `src/lib/orchestrator.ts`

```
UNDERSTAND (intent_classify, fast tier; heuristic fallback)
  work mode · job type (create/advise/build/analyze/lookup) · domains ·
  entities · needs_numbers · time_scope · lane weights · search queries
        ↓
RETRIEVAL PLAN = work-mode policy × intent  (lib/work-modes.ts)
        ↓
LANES in parallel (hybrid_search_lane: class filter in SQL = the right drawers)
  Reality · Learning · Playbooks · Platform (· Raw for analysts)
        ↓
SOFT BOOSTS (scoreCandidate): rank drives relevance; domain fit, type fit,
  endorsement, validation, authority, currency, priority only nudge
        ↓
RELATIONSHIP EXPANSION (1 hop over confirmed edges → candidates, not context)
        ↓
LANE-BALANCED POOL → RERANK → each strong lane keeps a seat → parent expansion
        ↓
LANE-GROUPED CONTEXT with identity headers:
  [id] ⟨MG-001 · Source of Energy · playbook/management/framework/accountability
        · authority B2 · endorsement approved · current⟩
  + PERFORMANCE MEMORY table when numbers are relevant
        ↓
REASONING ORDER instruction: reality → learning → standards → playbooks
```

Falls back to the classic pipeline before migration 0017. Feature flags in
settings: `features.orchestrator`, `autoWorkMode`, `relationshipExpansion`,
`learningDetection`.

## 5. Work modes — `src/lib/work-modes.ts`

One Brain, many expert jobs. **Auto** is the default (the intent classifier
picks; a manual pick overrides; a spoke's `allowedModes` allowlist keeps
restricted experts gated). Groups: General · Business (CEO Advisor, Strategy,
Sales Coach, Marketing, Offer Architect, Customer Success, Management Coach,
Hiring, Operations) · Content (Content Strategist, Copywriter, CEO Content,
Distribution) · Build (Training Builder, SOP Builder) · Analysis (Decision Memo,
Research Analyst). Each mode = a retrieval policy (lane weights, preferred
domains/types) + a reasoning overlay + a job framing (CREATE / ADVISE / BUILD).
Legacy ids (sales, media, strategy, decision_maker, ceo) remain aliases.

## 6. Organizational Learning

- **Detection in chat** (`src/lib/learning-detect.ts`): a keyword gate + a fast
  structured call; the Brain emits `learning_candidate` and the chatbot renders
  "Save as learning / Add evidence / Ignore". Nothing is believed without a
  human confirmation.
- **Save**: `POST /api/v1/learning` (spokes) or the Learning Lab → compiled as
  `organizational_learning` with a lifecycle row, `used_playbook` /
  `implemented_in` edges, missing evidence kept on the record.
- **Promote to PractiScale Standard** (Learning Lab): the playbooks it used
  become `practiscale_standard` / validated / implemented (authority B1) and are
  linked `adapted_into` / `validated_by`.

## 7. API surface

Public (scoped key): `POST /api/v1/chat` (accepts `mode`, `allowedModes`,
`attachments`; streams `mode`, `sources` with lanes/refs, `learning_candidate`),
`POST /api/v1/learning`, `GET /api/v1/collections`.

Admin (`/api/admin/knowledge/*`): `compile` (preview/commit, JSON or multipart),
`objects` (list, counts) + `objects/[id]` (detail / PATCH governance + markdown
re-index / DELETE), `taxonomy` (list / add / approve / reject / rename),
`relationships` (list / create / confirm / reject), `entities`, `decisions`,
`learning` (list / record / status / validate / promote), `metrics`.

## 8. Dashboard

**AI Brain**: Add knowledge (wizard: class → source → AI review → saved) ·
Knowledge objects (explorer + detail with governance editor, provenance,
relationships review, entities, learning chain, decision log, markdown editor)
· Learning Lab · Taxonomy (approval queue) · Relationships (suggestion queue) ·
Entities · Performance memory. **Operations**: Ingestion decisions.

## 9. Runbook

1. Apply `0017_operating_intelligence.sql` in the Brain Supabase (idempotent).
2. `npm run set:prompts` to publish the new prompt defaults as active versions
   (optional — code defaults are used until then).
3. Back-fill the knowledge pack: `npm run compile:knowledge -- <dir> --class playbook --dry`, then without `--dry`.
4. Review Taxonomy (proposals) and Relationships (suggestions) after the first batch.
5. Ask the chatbot in Auto mode; watch the "Auto → <expert>" chip and the
   lane labels in the Evidence panel.
