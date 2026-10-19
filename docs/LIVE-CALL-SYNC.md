# Live call status synchronization

Call-scoring is authoritative for `call_status` and `ticket_category`. A null
status is Pending; a null category is Unclassified. The model's original
`call_outcome` is historical and must never override a later CRM/QA decision.
Close rate uses closed / (closed + not_closed), excluding pending/disqualified.

## Delivery

Scoring migration `018_brain_sync.sql` adds a monotonically increasing
`coaching_reports.updated_at` and a transactionally written `brain_sync_outbox`.
New scores, manual edits, CRM outcome updates, and direct database writes enqueue
events. App writes kick delivery using Next.js `after()`. The scoring cron
`/api/cron/brain-sync` retries every minute and picks up direct database writes.

Each event carries only `{event_id, report_id, updated_at}`. Its HMAC-SHA256 is
signed over `timestamp + "." + exact JSON body`; headers are `x-brain-timestamp`
(Unix seconds) and `x-brain-signature: v1=<hex>`. Brain allows five minutes of
clock skew. Events are acknowledged only after durable inbox insertion.

Brain fetches the latest report by `report_id` using its existing source API key;
it never trusts a webhook's stale data snapshot. It resolves the organization
from the active registered source in the URL. One organization lease serializes
webhook workers. Both queues recover expired leases and retry failures. Fresh
events take priority over bootstrap work. Brain's existing jobs cron retries
inbox work every two minutes after a crash or transient failure.

Migration `0021_live_call_sync.sql` refreshes report and transcript documents by
organization + source + source type + source record ID. Embeddings are prepared
before a transaction swaps chunks. Document IDs remain stable, old append-only
duplicates are repaired, and older source revisions cannot overwrite newer ones.
The worker rebuilds Performance Memory before marking an event complete.

## Activation

1. Apply both migrations before deploying either application.
2. Configure Brain `SCORING_WEBHOOK_SECRET` with at least 32 random characters.
3. Set scoring `BRAIN_SYNC_WEBHOOK_SECRET` to exactly the same secret, and
   `BRAIN_SYNC_WEBHOOK_URL=https://<Brain production host>/api/webhooks/call-scoring/<registered source UUID>`.
   The production host must accept server requests without a Vercel login page.
4. Set scoring `CRON_SECRET` to a separate random secret; keep Brain's existing
   `CRON_SECRET`. Deploy both apps. Vercel Pro supports the minute-level cron.
5. After the scoring API deployment exposes `updated_at`, change the registered
   Brain source to `cursor_field=updated_at`, `cursor_param=updated_since`, and
   reset `cursor_value` to null for one reconciliation sweep. The API returns
   update-cursor results oldest-first to preserve partial-run progress.

Without webhook environment variables the integration remains disabled; normal
scoring works and durable source events wait for activation. Migration 018 queues
all existing calls once to repair historical changes missed by creation cursors.

## Verification and operations

`scripts/verify-scoring-sync.sql` checks replay, status replacement, stale
revision rejection, atomic rollback, clearing metadata, duplicate repair and
client permissions. The scoring repository's `database/verify-brain-sync.sql`
checks revision/outbox triggers, no-op updates, leases and permissions. Both
scripts roll back every change.

Monitor counts by status and oldest pending creation time in
`brain_sync_outbox` (scoring) and `scoring_sync_events` (Brain), plus attempts and
generic `last_error`. No transcript or contact data is stored in these queues.
The source considers `delivered` to mean durably accepted by Brain; only Brain's
`completed` means documents and metrics were refreshed. A temporary failure
remains retryable rather than silently marking the update complete.

For a production smoke test, update a clearly labeled test call through the
scoring UI or CRM endpoint, confirm both queues finish, compare the report and
transcript metadata, and ask the chatbot for that call's current status and
closing type. Restore/remove test data afterward.
