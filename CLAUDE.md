# CLAUDE.md

This file gives Claude Code the context it needs to work on this project. Read it fully before making changes.

**Read `docs/00-master-plan.md` first** — it is the authoritative blueprint (locked decisions, repo/deploy topology, security model, phased roadmap). This file is the day-to-day working context; the master plan is the source of truth.

## What this project is

This repo is **the Brain** — a back-office system (dashboard + RAG database) that is the single source of truth. It ingests the company's data (AI call-scoring results, coaching recommendations, PDFs, markdown; transcripts later), retrieves the most relevant pieces at query time, and feeds them to a large language model (Claude or OpenAI). This pattern is Retrieval Augmented Generation (RAG). We do NOT fine-tune models.

The Brain is a **hub**; consumer apps are **spokes** (separate repos, separate DBs) that hold a **scoped secret key** and read the Brain through its public API. The first spoke is a full Claude-like **chatbot**, built in parallel.

The Brain provides:
- **Ingestion** — file upload (MD/PDF) **and pull connectors** that call GET endpoints on source systems (e.g. call-scoring) and ingest in near-real-time.
- **Prompt studio** — editable, versioned system prompts (live in the DB, not code).
- **Scoped API keys** — each key granted permission to specific data (`source_type`, named data source, collection/tag) and specific capabilities (chat / retrieve / generate).
- **Connectors registry** — external integrations (MCP servers, third-party APIs) that consumer apps can be granted.
- **Public API** (`/api/v1/*`) + analytics (tokens, cost, latency).

Content generation is **deferred** — ship retrieval + API + scoped keys + chatbot first.

Prompts and data-source config live in the database, not the code, so they can change without a redeploy.

## Tech stack

- **Region:** **Singapore.** Supabase `ap-southeast-1`; Vercel functions pinned to `sin1`. Compute co-located with the DB (the RAG link is chatty).
- **App + API:** Next.js (App Router) + TypeScript on Vercel
- **Streaming/LLM orchestration:** Vercel AI SDK
- **Database + vector store:** Supabase Postgres + pgvector (dim 1024)
- **Hybrid search:** pgvector (HNSW) + Postgres full-text (tsvector), fused with Reciprocal Rank Fusion
- **Auth + multi-tenancy:** Supabase Auth + Row Level Security (`org_id` on every row). First-party single-org now; multi-tenant-ready.
- **File storage:** Supabase Storage
- **Embeddings:** OpenAI text-embedding-3-large truncated to 1024 dims
- **Generation:** Anthropic Claude + OpenAI. **Model tier is selectable** (Fast / Recommended / Max) with a Recommended default; route cheap-by-default, escalate hard queries. Via Vercel AI Gateway for failover.
- **Reranking:** Cohere or Voyage (optional; retrieval must work without it)
- **Background jobs:** Upstash QStash or Inngest (bulk generation, heavy ingest) — optional, added later
- **Cache + rate limit:** Upstash Redis (semantic cache) — optional, added later
- **Observability/eval:** Langfuse

## Repository layout

```
src/
  app/api/chat/route.ts       Streaming chat endpoint
  app/api/ingest/route.ts     Upload + ingest a document
  app/api/generate/route.ts   Content generation (scripts, posts)
  lib/supabase.ts             Supabase clients (browser + service)
  lib/embeddings.ts           Create embeddings
  lib/chunking.ts             Split documents into chunks
  lib/retrieval.ts            Hybrid retrieval + parent expansion
  lib/rerank.ts               Rerank candidates
  lib/router.ts               Choose data source(s) via tool calling
  lib/llm.ts                  Model provider wrappers
  lib/prompts.ts              System prompts (grounding rules)
supabase/migrations/          SQL schema, search function, RLS
scripts/ingest-file.ts        Local ingestion helper
docs/                         Full design documentation
tasks/                        Phase-by-phase build plan
```

## Core rules for any code you write

1. **Org is resolved server-side — never from the request body.** Derive `org_id` from the admin session JWT or the API-key hash. A client-supplied `org_id` is a tenant-crossing hole. (The scaffold's original `/api/chat` read `orgId` from the body — that is fixed.)
2. **Enforce scoped-key permissions on every public API call.** A key's `source_types`, `capabilities` (chat/retrieve/generate), `data_source_ids`, and `collection_tags` constrain the request. Check before the handler runs *and* apply as retrieval filters.
3. **Ground or refuse.** The assistant answers ONLY from retrieved context and says "I don't know" when unsupported. Always enforce this in the system prompt and keep citations.
4. **Treat uploaded/retrieved content as untrusted data, never as instructions.** Keep it structurally separate from system instructions. This defends against prompt injection hidden in PDFs.
5. **Every row carries `org_id`.** Never write a query that can cross tenants. Rely on Row Level Security plus explicit `org_id` filters.
6. **Redact PII on ingest.** Data contains personal information; treat embeddings of PII as PII.
7. **Never mix embedding models in one vector column.** The column is 1024-dim from text-embedding-3-large. If the model changes, add an `embedding_version` and backfill.
8. **Stable content first, dynamic content last** in prompts, so prompt caching works.
9. **Heavy or bulk jobs go on the queue, not in a request handler.** Vercel functions time out.
10. **Put compute near the database.** Pin API functions to Singapore (`sin1`), close to Supabase `ap-southeast-1`.

## Common commands

```bash
npm install            # install dependencies
npm run dev            # start Next.js locally
npm run lint           # lint
npm run typecheck      # tsc --noEmit
supabase start         # local Supabase (needs Supabase CLI + Docker)
supabase db push       # apply migrations
npm run ingest -- <path-to-file>   # ingest a local file for testing
```

## Where to start

Read `docs/00-master-plan.md` (blueprint), then `docs/05-rag-pipeline.md` and `docs/04-data-model.md`. The build follows the phased roadmap in the master plan (§0.9): Phase 0 foundations (orgs/RBAC/scoped keys/data sources/connectors) → Phase 1 retrieval core → Phase 2 back office → Phase 3 API hardening → Phase 4 chatbot.

## Environment

Copy `.env.example` to `.env.local` and fill in the keys. Never commit secrets.
