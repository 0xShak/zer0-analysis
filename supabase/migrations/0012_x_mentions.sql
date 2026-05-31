-- Mention-respond ledger for ZER0's public X (Twitter) profile. One row per
-- mention the mention-respond Inngest cron has seen. Doubles as the dedupe
-- guarantee: mention_id is the X tweet id of the incoming mention and is the
-- primary key, so a cron retry (or two overlapping ticks) can never make ZER0
-- reply to the same mention twice.
--
-- status lifecycle:
--   'pending'             row claimed; reply not yet posted
--   'replied'            ZER0 posted a grounded reply (reply_id set)
--   'skipped_ungrounded' lookupLiveMarkets() found no live market → the silence
--                        gate fired; ZER0 stays quiet rather than guess
--   'rate_capped'        hourly reply cap hit this tick; revisit next run
--
-- Service-role only; RLS enabled with no policies (matches x_posts/agent_usage).

create table public.x_mentions (
  mention_id text primary key,        -- X tweet id of the incoming mention; dedupe key
  author text,                        -- @handle that mentioned ZER0
  text text,                          -- the mention's text we read for grounding
  status text not null default 'pending',
  reply_id text,                      -- X tweet id of ZER0's reply; null until 'replied'
  created_at timestamptz default now(),
  constraint x_mentions_status_chk
    check (status in ('pending', 'replied', 'skipped_ungrounded', 'rate_capped'))
);

-- Reply-cap accounting and recency scans walk by time.
create index on public.x_mentions (created_at desc);

alter table public.x_mentions enable row level security;
-- No policies — service-role only, like x_posts.

-- Single-row cursor holding the since_id we pass to GET /2/users/:id/mentions
-- so each tick only fetches mentions newer than the last one processed. The
-- id=1 check keeps it a singleton — there is exactly one cursor.
create table public.x_mention_cursor (
  id int primary key default 1,
  since_id text,                      -- last mention_id handed to the X API; null on first run
  updated_at timestamptz default now(),
  constraint x_mention_cursor_singleton check (id = 1)
);

insert into public.x_mention_cursor (id, since_id) values (1, null);

alter table public.x_mention_cursor enable row level security;
-- No policies — service-role only.
