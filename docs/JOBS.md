# Background jobs

Heavy work that can't finish inside a serverless request — auditing hundreds or
thousands of call transcripts — runs as a **background job**. A job fans out into
small **tasks**; workers claim and run tasks one at a time; when the last task
finishes, the job's results are aggregated into a final report.

The engine is **runner-agnostic** (`src/lib/jobs/engine.ts`). The exact same queue
is drained by either runner:

| Runner | When | Limits |
| --- | --- | --- |
| **Vercel cron** (`/api/cron/jobs`, every 2 min) + an in-request kick | Always on. The floor. | ~300 s per run, sequential. Fine for tens of calls. |
| **Trigger.dev** | When `TRIGGER_SECRET_KEY` is set. | Dedicated machines, up to 3 h, **parallel agents**. For hundreds/thousands of calls. |

Both are safe to run at once — tasks are claimed atomically, so a task never runs
twice, and job counters are recomputed from the task rows (no lost updates under
parallelism). If Trigger.dev is unreachable, dispatch falls back to the cron path.

## How a job flows

1. A request to `POST /api/v1/jobs` (chatbot) or `POST /api/admin/jobs` (dashboard)
   parses the audit request, `createJob` + `planJob` (fan out into task rows),
   then `dispatchJob` (`src/lib/jobs/dispatch.ts`).
2. **Trigger.dev on:** `dispatchJob` triggers the `deep-call-audit` task, which
   sizes an agent pool to the work and runs `audit-worker`s in parallel, each
   calling `drainTasks`. The job's `runner_ref` is set to the Trigger.dev run id.
3. **Trigger.dev off:** `dispatchJob` drains a few tasks in the request background
   and the cron drains the rest.
4. `GET /api/v1/jobs/[id]` (or `/api/admin/jobs/[id]`) reports live progress; the
   chatbot renders it as a progress card on the chat screen.

## Enabling Trigger.dev (one-time)

Nothing here is required for the Brain to run — skip it and jobs run on the cron.

1. **Create a project** at <https://cloud.trigger.dev> (or self-host). Copy its
   **project ref** (Settings → General, `proj_…`) and a **server API key**
   (API Keys → the `tr_…` secret key for the env you deploy to).

2. **Set env vars.**
   - Local dev shell (for the CLI): `TRIGGER_PROJECT_REF=proj_…`
   - Vercel project env (Production + Preview): `TRIGGER_SECRET_KEY=tr_…`
   - In the **Trigger.dev dashboard → Environment Variables**, set everything the
     job subgraph reads at runtime (it runs on Trigger.dev's machines, not Vercel):
     `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`, the model/provider keys you use
     (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / AI Gateway), and `APP_SECRET`.
     Match the values in Vercel.

3. **Log in and deploy the tasks:**
   ```bash
   npm run trigger:login
   npm run trigger:deploy      # bundles src/trigger/* and deploys to Trigger.dev
   ```
   Re-run `trigger:deploy` whenever a task in `src/trigger/` changes. For local
   task development against real triggers, `npm run trigger:dev`.

Once `TRIGGER_SECRET_KEY` is set in Vercel **and** the tasks are deployed, new
jobs automatically use Trigger.dev. Remove the key to fall back to the cron.

## Files

- `src/lib/jobs/engine.ts` — generic engine: create / plan / claim / drain / finalize.
- `src/lib/jobs/handlers.ts` — the job-type registry.
- `src/lib/jobs/deep-call-audit.ts` — the `deep_call_audit` handler (batch → LLM
  audit per call → deterministic aggregate).
- `src/lib/jobs/dispatch.ts` — picks the runner (Trigger.dev vs cron).
- `src/trigger/deep-call-audit.ts` — Trigger.dev orchestrator + worker tasks.
- `trigger.config.ts` — Trigger.dev project config.
- `supabase/migrations/0018_jobs.sql` — `jobs` + `job_tasks` tables.

## Adding a new job type

1. Write a handler implementing `JobHandler` (`plan` / `runTask` / `finalize`).
2. Register it in `src/lib/jobs/handlers.ts` under a new `type` key.
3. That's it — the engine, both runners, and the progress API are generic. New
   data sources (beyond calls) plug in here without touching the runners.
