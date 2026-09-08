-- 0012_provider_secrets.sql — platform provider API keys, editable from the UI.
--
-- Lets a super-admin set/rotate the OpenAI / Anthropic / Cohere keys from the
-- dashboard instead of redeploying with new env vars. Provider keys are a
-- PLATFORM concern (one account serves every tenant), so this table is global —
-- not org-scoped.
--
-- Secrets are stored ENCRYPTED (AES-256-GCM, key derived from APP_SECRET; see
-- src/lib/secrets.ts) plus a non-secret last-4 for display. The table is only
-- ever read through the service-role client; RLS is enabled with NO policies, so
-- the anon/authenticated roles can never read it — a defence-in-depth lock even
-- though the app never queries it with those roles.
--
-- Idempotent.

create table if not exists provider_secrets (
  provider   text primary key,            -- 'openai' | 'anthropic' | 'cohere'
  ciphertext text not null,               -- AES-256-GCM: ivB64:tagB64:dataB64
  last4      text,                         -- last 4 chars of the secret, for display
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table provider_secrets enable row level security;
-- No policies: locked to the service role (which bypasses RLS). Never exposed to
-- the anon/authenticated (browser) roles.
