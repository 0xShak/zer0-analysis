-- Cached snapshot of Polymarket's active market catalog, so live-market search
-- (chat grounding + the X mention-respond cron) works from prod.
--
-- WHY: Gamma's /public-search — the full-catalog text-search endpoint — sits
-- behind Cloudflare bot protection that 403s prod's datacenter IPs (Vercel /
-- Inngest), even with a browser User-Agent. The /markets discovery feed is NOT
-- protected and works from prod, but it has no text search. So a scheduled
-- cron (zer0-catalog-refresh) walks /markets, stores the active catalog here as
-- one JSON blob, and readers search it in-memory. Serverless memory is
-- ephemeral (each invocation is cold), so the cache must live in the DB, not a
-- module-level variable.
--
-- Single row (id=1). Service-role only; RLS enabled with no policies.

create table public.market_catalog_cache (
  id int primary key default 1,
  markets jsonb not null default '[]',   -- compact market records (see catalog-cache.ts)
  market_count int not null default 0,
  updated_at timestamptz default now(),
  constraint market_catalog_singleton check (id = 1)
);

insert into public.market_catalog_cache (id, markets) values (1, '[]');

alter table public.market_catalog_cache enable row level security;
-- No policies — service-role only.
