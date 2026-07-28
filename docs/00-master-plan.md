# 0. Master Plan — Practiscale AI Enterprise System

> The authoritative blueprint. Every other doc and task follows from this. If a
> decision here conflicts with an older doc, this file wins.

Last updated: 2026-07-29.

---

## 0.1 What we are building (the shape)

A **hub-and-spoke platform**.

- **The Brain (hub)** — a back-office system: a dashboard plus the RAG database.
  It is the single source of truth. All company knowledge is ingested, chunked,
  embedded, and retrievable here. The Brain also mints **scoped secret keys** and
  exposes a **public API** that other apps call.
- **Consumer apps (spokes)** — separate products, each in its own repo with its
  own database, that hold only a **scoped key** and read the Brain through its
  public API. They can only touch the data and capabilities their key allows.

The first spoke is a **full conversational chatbot** (a Claude-like product), built
in parallel to exercise the Brain with real traffic.

```
                        ┌─────────────────────────────────────────┐
                        │              THE BRAIN (hub)             │
                        │  Back-office dashboard + RAG database    │
                        │                                          │
   Uploads (MD/PDF) ───▶│  • Ingestion (upload + PULL connectors)  │
   Pull GET endpoints ─▶│  • Chunk → embed → pgvector (hybrid)     │
   (call-scoring, etc.) │  • Prompt studio (versioned)             │
                        │  • Scoped API keys + permissions         │
                        │  • Connectors registry (MCP/3rd-party)   │
                        │  • Analytics (tokens, cost, latency)     │
                        │  • Public API  /api/v1/*                 │
                        └───────────────┬──────────────────────────┘
                                        │  scoped key (psk_...)
                    ┌───────────────────┼────────────────────┐
                    ▼                   ▼                    ▼
            ┌──────────────┐    ┌──────────────┐     ┌──────────────┐
            │  Chatbot     │    │  Other SaaS  │     │  Future app  │
            │ (own repo/DB)│    │ (own repo/DB)│     │ (own repo/DB)│
            └──────────────┘    └──────────────┘     └──────────────┘
```

We do **not** fine-tune models. "Trained enterprise AI" = strong retrieval (RAG) +
strong, versioned prompts.

---

## 0.2 Locked decisions (from kickoff, 2026-07-29)

| # | Decision | Choice |
|---|---|---|
| 1 | Tenancy | **First-party now, sell externally later.** Single org today, but `org_id` + RLS on every row so multi-tenant is never a retrofit. |
| 2 | Scope of build | **Full project, not a cut-down v1.** Build the complete scoped-key permission model (all granularities), not a subset. |
| 3 | Key scoping granularity | Scope by **data type** (source_type) **+ capability** (chat / retrieve / generate) **+ named data source** **+ collection/tag**. All four. |
| 4 | External ingestion | **Pull.** The Brain calls GET endpoints that the source systems (e.g. call-scoring) expose, and ingests in near-real-time. (Upload also supported.) |
| 5 | Data | Call scores, coaching recommendations, PDFs/markdown. **Transcripts later.** |
| 6 | PII | **Yes, contains personal data.** Redact on ingest, RLS everywhere, treat embeddings of PII as PII. |
| 7 | Residency / region | **Singapore.** Supabase `ap-southeast-1`; compute co-located (Vercel `sin1`). |
| 8 | Admin access | **Super-admin**, who can create more admins with **granular per-admin permissions**. |
| 9 | Providers | Anthropic (Claude) + OpenAI (embeddings + generation). Cohere/Upstash optional, added later. |
| 10 | Model tier | **Selectable** in the UI with a **Recommended** default. Cheap-model default, escalate hard queries. Exposed in Brain (per prompt/key) and chatbot (switcher). |
| 11 | Content generation in Brain | **Deferred.** Ship retrieval + API + scoped keys + chatbot first. |
| 12 | First milestone | Full end-to-end scoped-key flow (see 0.8). |
| 13 | Hosting | **Vercel + Supabase (Singapore).** |
| 14 | Repos | **Polyrepo** (see 0.3). |

---

## 0.3 Repository topology (polyrepo)

| Repo | Purpose | Holds secrets? |
|---|---|---|
| **the Brain** (this repo) | Back office + RAG DB + public API. The hub. | Yes — service-role key, provider keys, all data. |
| **the Chatbot** | Claude-like conversational product. Own DB (users, chats, projects). | Only a scoped Brain key + its own auth secrets. |
| **practiscale-ai-client** *(optional, later)* | Typed TS SDK for the public API, published to npm. Consumer apps import it. | No. |
| *(one repo per future consumer app)* | Same pattern as the chatbot. | Only a scoped key. |

**Actual repos & local layout** (set up 2026-07-29):

| Component | GitHub | Local path |
|---|---|---|
| Brain (this repo) | `github.com/practiscaledevops/practsicale-rag-backend-` | `C:\Users\IT TRADERS\Desktop\Brain\practiscale-rag-backend` |
| Chatbot | `github.com/practiscaledevops/practiscale-rag-chatbot` | `C:\Users\IT TRADERS\Desktop\Brain\practiscale-rag-chatbot` |

The ERP (`C:\Users\IT TRADERS\Desktop\Finance Management`) is a separate, unrelated
project — nothing from this platform belongs there.

**Why polyrepo:** isolation is the whole point. A consumer-app developer must never
be able to reach the Brain's internals or another tenant's data — they only ever
hold a scoped key. Separate repos enforce that boundary, keep deploy cadences
independent, and shrink blast radius. Shared types travel through the SDK package,
not a shared codebase.

---

## 0.4 Deployment topology

- **Brain:** Vercel (Next.js, functions pinned to `sin1`) + Supabase Postgres +
  pgvector in `ap-southeast-1` (Singapore). Compute and DB co-located — the RAG
  link (compute↔DB) is chatty; co-locating it is the biggest latency win.
- **Chatbot:** its own Vercel project + its own Supabase (Singapore) for users,
  chat history, projects. Calls the Brain's `/api/v1/*` with a scoped key.
- **Model providers:** Anthropic + OpenAI are US-anchored. We hide that hop with
  **streaming** (time-to-first-token is what users feel) and **prompt caching**.
  Route through the **Vercel AI Gateway** for multi-provider failover.
- **Later, if needed:** Supabase read replicas near distant users; a dedicated
  vector DB only past ~5–10M vectors.

---

## 0.5 Data model (additions on top of the scaffold)

The scaffold ships `documents`, `chunks` (pgvector + tsvector + parent_id),
`prompts`, `conversations`, `messages`, `api_keys`. We add:

- **orgs** — tenant root. Everything references `org_id`.
- **org_members** — admins/users in an org, with a **granular permission set**
  (JSON of allowed actions) so a super-admin can create admins with specific access.
- **api_keys (extended)** — a `key_prefix` + `key_hash`, plus a **scope**: allowed
  `source_types[]`, `capabilities[]` (chat/retrieve/generate), `data_source_ids[]`,
  `collection_tags[]`, rate limit, expiry, revoked flag, and usage counters.
- **data_sources** — registered **pull endpoints** (URL, auth config, schedule,
  cursor/watermark, last-sync status). This is how the call-scoring system feeds in.
- **connectors** — external integrations (MCP servers, third-party APIs like a
  Higgsfield image/video API) that consumer apps can be granted and use.
- **collections** / document tags — for the finest-grained key scoping.
- **usage_events** — per-key/per-model token + cost + latency metering.
- **ingestion_runs** — audit of every ingest/sync (source, counts, errors, hash).

RLS: every table carries `org_id`; policies isolate by the authenticated org.
Server ingestion uses the service role (bypasses RLS) but **always** filters by the
org resolved server-side — never a client-supplied `org_id`.

---

## 0.6 Security model (non-negotiable)

1. **Org is resolved server-side** from the admin session JWT or the API-key hash —
   **never** from the request body. (Fixes the scaffold's tenant-crossing hole.)
2. **Scoped-key enforcement** on every public API call: the key's `source_types`,
   `capabilities`, `data_source_ids`, and `collection_tags` constrain what the
   request can retrieve or do. Enforced in the retrieval filter *and* checked before
   the handler runs.
3. **Ground or refuse** — answers only from retrieved context; cite chunk ids; say
   "I don't know" when unsupported.
4. **Untrusted content isolation** — uploaded/retrieved text is data, never
   instructions. Structurally separated from the system prompt. Defends against
   prompt injection in PDFs.
5. **PII** — redact on ingest, store under RLS, treat embeddings of PII as PII.
6. **Keys** — shown once at creation, stored only as a hash. Revocable. Metered.

---

## 0.7 Public API (consumed via scoped keys)

Base: `/api/v1`, auth via `Authorization: Bearer psk_...`.

| Endpoint | Capability required | Purpose |
|---|---|---|
| `POST /api/v1/chat` | `chat` | Grounded, cited, streamed answer over the key's permitted data. |
| `POST /api/v1/retrieve` | `retrieve` | Raw retrieval (chunks + scores) for apps that do their own generation. |
| `POST /api/v1/generate` | `generate` | Content generation (scripts/posts) over permitted data. *(later)* |
| `GET  /api/v1/sources` | — | List the data sources this key may see. |
| `GET  /api/v1/usage` | — | This key's token/cost usage. |

Every request is filtered by the key's scope before it touches the database.

---

## 0.8 First milestone (definition of "it works")

> In the Brain dashboard: **upload a PDF** and **pull one call-score record** from a
> registered GET endpoint → both are ingested and searchable. **Mint a key scoped to
> `call_score` + `chat`.** The chatbot, holding that key, **answers a grounded, cited
> question** using only call-score data, and is **refused** when it asks for something
> outside its scope (e.g. coaching notes).

That single flow proves ingestion, retrieval, grounding, scoped keys, and the API —
the whole platform — end to end.

---

## 0.9 Phased roadmap

| Phase | Goal | Repo |
|---|---|---|
| **0 — Foundations** | Schema (orgs, RBAC, scoped keys, data sources, connectors, collections, usage), security-correct org resolution, key verification + scope enforcement. | brain |
| **1 — Retrieval core** | Ingestion (upload + pull connectors), chunking by type, PII redaction, hybrid retrieval, grounded `/api/v1/chat`, eval set. | brain |
| **2 — Back office** | Dashboard: auth + admin management, data sources, uploads, documents, prompt studio, keys, connectors, analytics, playground. | brain |
| **3 — API hardening** | Capabilities, metering, rate limits, semantic cache, model routing, SDK. | brain |
| **4 — Chatbot** | Full Claude-like app: logins, history, chatrooms, projects, model switcher, token meter, connectors, streaming. | chatbot |
| **5 — Generation + scale** | Content generator, MCP connectors, read replicas, batch jobs. | both |

---

## 0.10 Model tiers (selectable, with a Recommended default)

Exposed as a setting (per prompt/key in the Brain, and a switcher in the chatbot):

| Tier | Default model | When |
|---|---|---|
| **Fast (cheapest)** | Claude Haiku 4.5 / GPT-4o mini | Easy Q&A, high volume. |
| **Recommended (default)** | Claude Sonnet | Most chat and generation. |
| **Max quality** | Claude Opus / GPT-5.5 | Hard, analytical, high-stakes. |

A cheap model is the default; hard queries escalate. The router keeps its decision
under ~50–100ms so it never eats the savings. Token/cost per turn is metered and
shown.
