-- Shared, Postgres-backed fixed-window rate limiter for the serverless trade
-- routes (/api/trade/* and /api/polymarket/builder-sign).
--
-- Why: those routes used an in-memory Map (src/lib/trades/rate-limit.ts) that
-- is per-instance. On Vercel each invocation can land on a fresh/parallel
-- instance, so the cap did almost nothing against a concurrent or distributed
-- caller. This table is shared across all instances. Fixed-window (not sliding)
-- is enough for abuse prevention and costs one upsert per request.
--
-- The Telegram bot keeps its own in-memory limiter — it's a single always-on
-- process, so per-instance state is correct there.

create table public.rate_limit_buckets (
  bucket_key   text   not null,
  window_start bigint not null,  -- epoch seconds, floored to the window start
  count        int    not null default 0,
  primary key (bucket_key, window_start)
);

-- Atomically bump the current window's counter and return the new count.
-- window_start = now_epoch floored to the window so all callers in the same
-- window converge on one row.
create or replace function public.incr_rate_limit_window(
  k text, window_seconds int, now_epoch bigint
) returns int as $$
  insert into public.rate_limit_buckets(bucket_key, window_start, count)
  values (k, now_epoch - (now_epoch % window_seconds), 1)
  on conflict (bucket_key, window_start)
    do update set count = public.rate_limit_buckets.count + 1
  returning count;
$$ language sql;

alter table public.rate_limit_buckets enable row level security;
-- service_role only — no CREATE POLICY. The routes use the admin client.

-- Optional housekeeping: stale windows can be swept by a cron with
--   delete from public.rate_limit_buckets where window_start < extract(epoch from now()) - 3600;
