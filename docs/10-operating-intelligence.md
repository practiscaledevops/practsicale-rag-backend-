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

### Ingestion sources — `src/lib/ingest-adapters/`

One door for every source (spec §29–30): an adapter extracts the text, the
compiler does the rest. Each returns `{ text, title?, meta: { source_type?,
source_platform?, source_url?, duration_s?, pages? } }` or throws a readable
`ExtractError` (its `status` becomes the HTTP status).

| Adapter | Source | How |
| --- | --- | --- |
| `url.ts` | article, LinkedIn / Instagram / X post, any page | SSRF-guarded fetch (`assertPublicUrl` on every hop, 15 s, 2 MB, browser UA) → `<article>` / `<main>` / `<body>` → chrome and scripts stripped, entities decoded; og:title; platform from the hostname. A login wall (< 200 usable chars) is refused with a "paste the transcript" hint. A link straight to a PDF is decoded as one. |
| `youtube.ts` | YouTube video / short | caption tracks from YouTube's player endpoint as the Android client (the web client's timedtext URLs answer empty without a browser token; the watch page is the fallback), human English → auto English → any, json3 with the srv3/XML fallback, joined into paragraphs; title / author via oEmbed; duration from the player. No captions → title + description, flagged "(no captions available — description only)". |
| `pdf.ts` | PDF, ≤ 50 MB | pdf-parse (the same entry the upload path uses) + page count + embedded Title. A scan (no text layer) is refused with an "export it with OCR" hint — no OCR here. |
| `audio.ts` | voice note, call, meeting — mp3 m4a wav mp4 webm ogg, ≤ 25 MB (the transcription service's limit) | OpenAI `gpt-4o-mini-transcribe`, `whisper-1` when unavailable; key via `getProviderKey("openai")` (Settings → Provider API keys). |
| `image.ts` | screenshot — png jpg webp gif, ≤ 10 MB | OpenAI vision (`gpt-4o-mini`): transcribe every piece of text in reading order, tables as Markdown, charts as data, no commentary. |
| `index.ts` | `extractAny({ url } \| { file }, { full? })` | YouTube host → `youtube`, else `url`; files by extension then MIME (txt / md / csv / json decoded as UTF-8); result capped at 60k chars (`truncated: true`) — or at `MAX_LONG_TEXT_CHARS` (2M) with `full`, which only the admin route may ask for. Client-safe helpers (`kindOfFile`, `isYouTubeUrl`, `parseYouTubeId`, `capText`, the size limits) live in `pure.ts`. |

Routes (`sin1`): `POST /api/admin/knowledge/extract` (admin, `documents:write`,
`maxDuration = 300`) feeds the Add-knowledge wizard's "Upload a file" / "From a
link" modes, which drop the text into the source box and pre-fill the
provenance hints (url, platform, source type, title). `POST /api/v1/extract`
(scoped key, capability `chat`, rate-limited, `maxDuration = 120`) gives a spoke
the same extraction for what its users attach — nothing is stored. Both accept
multipart `file` (≤ 4 MB) | `url` or JSON `{ url }` and reply `{ name, kind,
title, text, chars, truncated, meta }` or `{ error }`. The admin route alone
also accepts `{ storagePath, name, mime?, full? }` and the `full` flag (below).

Call transcripts: the call-scoring pull connector (`src/lib/connectors/pull.ts`)
requests `include_transcript=true` and now emits **two** documents per call — the
existing `call_score` report (transcript stripped, so it stays lean) and a linked
`transcript` document (`intelligence_class = business_reality`, `domain = sales`)
carrying the same structured metadata (consultant, date, outcome, score/band,
`practice_type` surfaced as `category`) plus `kind: "transcript"` and
`linked_call_score_id` (the shared record id). Transcripts chunk by speaker turn
(`chunkDocument("transcript")`): a summary chunk first (call identity + first/last
turns), then ~1,400-token, time-anchored chunks with ~15% turn overlap, so a
day's or a consultant's calls filter by date + consultant + practice type.
Back-fill past calls with `npm run backfill:transcripts` or the source health
page's "Back-fill transcripts" button (`POST /api/admin/sources/[id]/backfill-transcripts`).

### Large uploads — `src/lib/knowledge-uploads.ts`

The hosting platform rejects request bodies over ~4.5 MB before a handler runs,
so the wizard POSTs a file up to 4 MB directly and sends anything bigger (to
**50 MB** — a book PDF, a long recording) through Supabase Storage:

```
POST /api/admin/knowledge/upload-url { name, size, mime }     documents:write, maxDuration 30
  → 413 over 50 MB · 415 unsupported kind (kindOfFile)
  → { bucket: "knowledge-uploads", path: "org/<orgId>/<uuid>-<safe name>", signedUrl, token }
PUT signedUrl                                                  browser → storage directly (XHR: real
                                                               progress %, Cancel; same request as
                                                               supabase-js uploadToSignedUrl)
POST /api/admin/knowledge/extract { storagePath, name, mime?, full: true }
  → download → the same adapters → the object is DELETED (success or failure) → the usual reply
```

The bucket is private (created on first use, `fileSizeLimit` 50 MiB). Paths are
org-prefixed from the **admin session** and re-verified server-side
(`assertOrgPath`: exact `org/<orgId>/<uuid>-<name>` shape, no `..`, no nesting →
403 otherwise) before a download; the service-role client never leaves the
server. Uploads are ephemeral — leftovers older than 24 h (a tab closed before
extraction) are swept when the next upload URL is issued. A failed upload's
Retry asks for a fresh URL.

### Long sources (books, courses, reports) — `src/lib/long-source-pure.ts`, `src/lib/long-source.ts`

One object from ≤ 60k chars is wrong for a book: each chapter is its own
framework. A source over **40k chars** gets the wizard's *Long source* panel
instead of the single-object button ("Compile as one object anyway" keeps the
old path and says it reads only the first 60k):

```
headingCandidates(text)      BROWSER. Lines of 4–70 chars, ≤ 10 words, no terminal . , ; : ! ?,
                             after a blank line, ≥ 70% of the words capitalised (connectors such
                             as of/the/to ignored; markdown #, *emphasis* and quotes stripped)
POST …/knowledge/outline     { candidates: [{ index, text, hint = next non-empty line }] ≤ 600 × ≤ 200
                             chars, title? } — ONLY this list travels, never the text. One
                             structured() call on intelligence.classifyTier returns the lines that
                             start a TOP-LEVEL unit (not sub-headings, not cover/contents;
                             Introduction/Conclusion count) + the work's title and author.
                             Typography cannot tell a chapter title from a sub-heading — the model
                             can (a chapter is followed by an epigraph, a sub-heading by prose).
                             Candidate lines are data, never instructions.
                             → { title, author, chapters: [{ index, title }], via: "model"|"fallback" }
splitByOutline(text, …)      BROWSER. Section i = chapter i's offset → chapter i+1's. Text before
                             the first chapter is "Front matter" only with ≥ 1,500 chars of real
                             prose (unticked by default; else dropped); a section < 1,500 chars
                             merges into the next; a section > 30,000 chars is sub-split at heading
                             candidates into "Title (part 1/2)". Contiguous, covering.
fallbackChapters(text)       no model / < 3 chapters: ~14k-char parts cut at the nearest heading or
                             paragraph break, "Part N — <first heading inside>".
```

The checklist (work title, author, kind; per-section title, size, preview) then
drives the batch **client-side, two at a time**: each ticked section is POSTed
to the existing compile route — `{ mode: "commit", class, bucket?, text: <slice>,
title: "<work> — <section>" (provenance: the raw document's title), hints: {
…the wizard's hints, sourceType: book|course|…, sourceExpert: <author>,
sourcePlatform: book|course when unset, tags: [<work-title slug>] }, overrides:
{ name: <section title> } }` (no name override for positional titles such as
"Introduction" / "Part 3" — the compiler names those). Rows show queued →
compiling → NEW `MKT-004` / ENRICHED `SAL-002` / DUPLICATE / CONFLICT / BLOCKED
(reason) / failed + Retry; Pause / Resume; one failure never stops the rest; two
parts of one chapter never run together (the second should meet the first in
dedup); `beforeunload` warns mid-batch. Progress (outline + outcomes, no text)
is filed in `localStorage` under `sourceKey(source name, text)` so a reload can
"Resume where you left off" after re-selecting the file; re-running a source is
safe regardless — dedup answers DUPLICATE / ENRICH. No new tables or columns.
~45–60 s per section; each compile stays inside the route's `maxDuration`.

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
`POST /api/v1/learning`, `GET /api/v1/collections`, `POST /api/v1/extract`
(link / YouTube / PDF / audio / image → text for a spoke, capability `chat`; see §3).

Brain map (read-only, capability `chat` **or** `retrieve`, rate-limited like
retrieve, `Cache-Control: private, max-age=15`; logic in `src/lib/knowledge-read.ts`):

| Endpoint | Contract |
| --- | --- |
| `GET /api/v1/knowledge?class=&domain=&type=&q=&sensitive=1\|0&includeArchive=0\|1&limit=&offset=` | `{ counts: { total, byClass, byDomain, byType, learningByType, entitiesByKind, relationships: { confirmed, suggested }, metrics }, objects: [{ id, ref, name, summary, intelligence_class, domain, object_type, subtype, tags, authority, founder_endorsement, implementation_status, internal_validation, status, current, priority, updated_at, last_verified_at, source_platform, source_expert }], page: { limit, offset, returned } }`. `counts` are org-wide (ignore the filters); `objects` respect them (`q` = ref/name/summary ilike or a tag; `updated_at` desc; `limit` ≤ 50, default 30). `raw_archive` is excluded unless `includeArchive=1`. `sensitive=0` hides business-reality `call`/`call_score`/`transcript`/`kpi_report` objects and the call-score team snapshot (`attributes.snapshot = 'call_scores'`). |
| `GET /api/v1/knowledge/[ref]?sensitive=1\|0` | `[ref]` = stable ref (MG-001, BR-SAL-003) or uuid. `{ object: { …list projection…, compiled_markdown (≤ 12k chars + "(truncated)" marker), applies_to, goals, platforms, business_functions, effective_from, effective_until, source_type, source_url, source_date, source_claims, sources, evidence_level, bucket }, relationships: [{ id, type, direction: "out"\|"in", status, ref, name, intelligence_class }], learning: [{ id, ref, record_type, title, status, department, created_at }], chunks }`. `sensitive=0` → 404 for a sensitive object and sensitive neighbours dropped. |
| `GET /api/v1/learning?status=&type=&limit=&offset=` | `{ records: [{ id, ref, record_type, title, status, department, owner, summary, created_at, updated_at, metrics_before, metrics_after, missing_evidence, playbooks: [{ ref, name }], object_ref }], page }`, `created_at` desc, `limit` ≤ 50. `playbooks` = the targets of the record's `used_playbook` / `implemented_in` edges. |

Pre-migration (no `knowledge_objects`) these answer `503 { migrationMissing: true }`.

Admin (`/api/admin/knowledge/*`): `compile` (preview/commit, JSON or multipart),
`extract` (source → text for the wizard: multipart `file`, JSON `{ url }` or
`{ storagePath }`; `full` lifts the text cap), `upload-url` (signed upload URL
for a file of 4–50 MB), `outline` (heading candidates → the chapters of a long
source; all three in §3),
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
