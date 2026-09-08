-- Brain schema upgrade: migration 0012 (provider_secrets).
-- Run in the practiscale-brain-rag SQL editor. Idempotent.
-- Lets a super-admin set/rotate OpenAI/Anthropic/Cohere keys from the dashboard
-- (Settings → Provider API keys). Stored encrypted; read only via service role.

create table if not exists public.provider_secrets (
  provider   text primary key,
  ciphertext text not null,
  last4      text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.provider_secrets enable row level security;
-- No policies: locked to the service role; never exposed to browser roles.
