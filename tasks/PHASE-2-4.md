# Phases 2 to 4 — Summary Backlog

## Phase 2 — The assistant
- Chat UI with the Vercel AI SDK (streaming, stop, regenerate, edit-and-rerun).
- Inline numbered citations that open a source card.
- Conversation memory: working buffer + session summary; persist to `conversations` and `messages`.
- Thread history (rename, search, archive, export).
- Accessibility: ARIA live region (role=log) for streaming, full keyboard operation, focus management, contrast, reduced motion.

## Phase 3 — Content generation
- Templated generators (video script, social post, training module) in `src/lib/prompts.ts` and dashboard-editable `prompts` table.
- Brand voice profile injected into generation.
- Regenerate with variations; human review before publish.
- Bulk generation via a queue (Upstash QStash or Inngest) with a worker; use the Batch API for cost.

## Phase 4 — Platform and worldwide scale
- API keys + usage metering (`api_keys` table); rate limiting via Upstash.
- Full multi-tenant isolation verified end to end.
- Cost levers: prompt caching, model routing (cheap vs flagship), semantic caching.
- Supabase read replicas near distant users; Vercel AI Gateway for provider failover.
- Admin analytics dashboard; prompt versioning and evaluation over time.
- Regional data residency options for regulated tenants.
