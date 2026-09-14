-- 0013_collection_settings.sql — collections as governance units.
-- One jsonb column holds the governance config (owner, access level, allowed work
-- modes, review interval, retention, eligibility flags, default source type), so
-- the shape can evolve without further migrations. The dashboard degrades
-- gracefully (governance editor disabled) until this column exists.

alter table public.collections
  add column if not exists settings jsonb not null default '{}'::jsonb;
