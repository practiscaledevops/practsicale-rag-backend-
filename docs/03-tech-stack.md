# 3. Tech Stack

| Layer | Technology | Runs on |
|---|---|---|
| App + interface | Next.js (App Router), TypeScript, Vercel AI SDK | Vercel |
| API + RAG orchestration | Vercel Functions (Node), Vercel AI Gateway | Vercel |
| Database + vector store | Supabase Postgres + pgvector (1024 dim) | Supabase |
| Hybrid search | pgvector HNSW + Postgres tsvector, RRF fusion | Supabase |
| Auth + multi-tenancy | Supabase Auth + Row Level Security | Supabase |
| File storage | Supabase Storage | Supabase |
| Embeddings | OpenAI text-embedding-3-large @ 1024 dims | OpenAI API |
| Generation | Anthropic Claude + OpenAI | Provider APIs |
| Reranking | Cohere Rerank or Voyage | Provider API |
| Background jobs | Upstash QStash or Inngest | External |
| Cache + rate limit | Upstash Redis (semantic cache) | External |
| Observability + eval | Langfuse | External |

## Important boundary

Vercel runs the code. Supabase holds the data. Long or bulk jobs run on the queue. "Everything on Vercel" means the app, the API, and the retrieval logic. The database is Supabase; that split is deliberate.
