# Practiscale Brain

The back office and RAG database behind Practiscale, built on Next.js, Vercel, and Supabase. It ingests your data, retrieves the relevant pieces at query time, and answers with Claude or OpenAI — grounded in your own content, not fine-tuned.

The Brain is the hub: a chatbot, a content generator, and a public API all read from one Supabase + pgvector store through scoped keys.

## Quick start

1. **Prerequisites:** Node 20+, a Supabase project, an OpenAI key, an Anthropic key. Optional: Cohere (rerank), Upstash (cache/queue).
2. **Install:**
   ```bash
   npm install
   cp .env.example .env.local   # then fill in the values
   ```
3. **Database:** apply the migrations in `supabase/migrations/` (via the Supabase CLI `supabase db push`, or paste them into the Supabase SQL editor in order).
4. **Run:**
   ```bash
   npm run dev
   ```
5. **Ingest a test document:**
   ```bash
   npm run ingest -- ./sample.md
   ```
6. **Ask a question:** POST to `/api/chat` (see `docs/06-api-reference.md`).

## Documentation

Full design and build docs live in `docs/`. Start with `docs/01-overview.md`, then `docs/10-getting-started.md`.

## Kicking off with Claude Code

Open this folder in Claude Code. It reads `CLAUDE.md` automatically for project context. Then say: "Read tasks/PHASE-1.md and implement it step by step." Claude Code will build the retrieval loop first.

## Status

This is a starter scaffold. The library and API files contain working starter implementations and clearly marked TODOs. Follow the phase plan in `tasks/`.
