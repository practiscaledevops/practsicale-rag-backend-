# Provider usage and operational limits

Brain records provider attempts in the service-only provider_usage_ledger table. This
includes helpers, embeddings, generation, image transcription and audio attempts.
A missing provider receipt leaves estimated_usd null. It does not mean the call was free.
The existing Analytics totals remain request-level and should not be added to this ledger.

Set BRAIN_DAILY_MODEL_BUDGET_USD to enable a shared, UTC-day admission limit for
Brain model calls. Leave it unset for accounting without a spending ceiling.
The limit uses estimated list prices and conservatively reserves for calls with
no receipt. Provider invoices remain authoritative. Other apps using the same
keys, older workers, and standalone scripts outside Brain can incur charges.
Legacy duration-priced audio fallback is disabled when a cap is active.

Generic jobs reclaim interrupted tasks after a 20-minute lease and stop retrying
after three claims or the job deadline. The attempt number fences task results.
Generic duplicate uploads in the same scope reserve preparation for up to 20
minutes. If the reservation is busy, retry after the first upload finishes.
