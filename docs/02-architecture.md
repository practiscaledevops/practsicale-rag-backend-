# 2. Architecture

## Two planes, one brain

**Control plane (admin dashboard):** edit prompts, register data sources, upload PDFs and markdown. Uploads trigger ingestion automatically.

**The brain (shared engine):** Supabase Postgres with pgvector plus the retrieval logic running in Vercel functions.

**Data plane (apps):** chatbot, content generator, external apps. Each connects with an API key.

## Request path (runtime)

1. Question arrives at a Vercel API function.
2. Router chooses the data source(s) via tool calling.
3. Hybrid retrieval (vector + full text) fetches candidates from pgvector.
4. Reranker keeps the best few.
5. Parent expansion adds surrounding context.
6. Prompt is assembled (stable content first, question last).
7. LLM streams the answer, grounded and cited.

## Placement

Put the Vercel API functions and the Supabase primary database in the same US region, close to the model providers. Stream to the user so distance is hidden. Add Supabase read replicas near distant users later.

## Background work

Bulk generation and heavy ingestion run on a queue (Upstash QStash or Inngest) with a worker, never inside a request handler.
