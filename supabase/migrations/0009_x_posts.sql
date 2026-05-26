-- Auto-posting log for ZER0's public X (Twitter) profile. One row per thing
-- ZER0 has published to X. Doubles as the idempotency ledger: the x-broadcast
-- Inngest function claims a row BEFORE calling the X API, so an Inngest step
-- retry (or two overlapping ticks) can never post the same signal — or the
-- same day's digest — twice.
--
--   kind='signal'  ref_id = trade_recommendations.id (the call being announced)
--   kind='digest'  ref_id = the UTC date 'YYYY-MM-DD' the recap covers
--
-- Service-role only; RLS enabled with no policies (matches agent_usage).

create table public.x_posts (
  id bigserial primary key,
  kind text not null,                 -- 'signal' | 'digest'
  ref_id text not null,               -- recommendation id, or UTC date for digests
  tweet_id text,                      -- X tweet id; null until the post succeeds
  content text,                       -- the text actually posted; null at claim time
  posted_at timestamptz default now()
);

-- The idempotency guarantee: at most one post per (kind, ref_id).
create unique index x_posts_kind_ref_uniq on public.x_posts (kind, ref_id);
create index on public.x_posts (posted_at desc);

alter table public.x_posts enable row level security;
-- No policies — service-role only, like agent_usage.
