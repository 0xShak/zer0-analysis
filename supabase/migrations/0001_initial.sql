-- ZER0 initial schema — see zer0.md §5
-- Apply via `supabase db push` after `supabase link --project-ref <ref>`.

------------------------------------------------------------------------------
-- USERS & SESSIONS
------------------------------------------------------------------------------

create table public.users (
  id uuid primary key default gen_random_uuid(),
  wallet_address text unique,
  telegram_user_id bigint unique,
  display_name text,
  created_at timestamptz default now()
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id),
  anon_fingerprint text,
  channel text not null check (channel in ('web','telegram')),
  created_at timestamptz default now()
);
create index on public.sessions (anon_fingerprint);

------------------------------------------------------------------------------
-- MESSAGES (shared across channels via user_id)
------------------------------------------------------------------------------

create table public.messages (
  id bigserial primary key,
  session_id uuid references public.sessions(id),
  user_id uuid references public.users(id),
  role text not null check (role in ('user','assistant','system')),
  channel text not null,
  content text not null,
  created_at timestamptz default now()
);
create index on public.messages (user_id, created_at desc);

------------------------------------------------------------------------------
-- CHAIN OF THOUGHT (two-tier visibility — public landing, app authenticated)
------------------------------------------------------------------------------

create table public.thoughts (
  id bigserial primary key,
  market_condition_id text,
  scope text not null check (scope in ('public','app')),
  content text not null,
  tokens_in int,
  tokens_out int,
  created_at timestamptz default now()
);
create index on public.thoughts (created_at desc);

------------------------------------------------------------------------------
-- MARKET SCANS (dedupe key for the Inngest brain tick)
------------------------------------------------------------------------------

create table public.market_scans (
  condition_id text primary key,
  question text,
  last_seen_at timestamptz default now(),
  deterministic boolean,
  category text,
  classifier_confidence numeric(3,2),
  classifier_reason text
);

------------------------------------------------------------------------------
-- TRADE RECOMMENDATIONS
------------------------------------------------------------------------------

create table public.trade_recommendations (
  id uuid primary key default gen_random_uuid(),
  market_condition_id text not null,
  market_question text,
  token_id text not null,
  side text not null check (side in ('BUY','SELL')),
  price numeric(5,4) not null,
  size numeric(18,6) not null,
  conviction numeric(3,2) not null,
  rationale text not null,
  neg_risk boolean default false,
  status text default 'open',
  created_at timestamptz default now(),
  expires_at timestamptz
);
create index on public.trade_recommendations (status, created_at desc);

------------------------------------------------------------------------------
-- ENTITLEMENTS & PAYMENTS
------------------------------------------------------------------------------

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id),
  session_id uuid references public.sessions(id),
  unlocked_until timestamptz not null,
  source text not null,
  created_at timestamptz default now()
);
create index on public.entitlements (user_id);
create index on public.entitlements (session_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id),
  session_id uuid references public.sessions(id),
  coinbase_charge_id text unique,
  status text,
  amount_usd numeric(10,2),
  created_at timestamptz default now(),
  confirmed_at timestamptz
);

------------------------------------------------------------------------------
-- RATE LIMITING (anonymous: 5 msgs/day per fingerprint)
------------------------------------------------------------------------------

create table public.rate_limits (
  fingerprint text primary key,
  day date not null default current_date,
  count int default 0
);

create or replace function public.increment_rate_limit(fp text, today date)
returns public.rate_limits as $$
  insert into public.rate_limits(fingerprint, day, count) values (fp, today, 1)
  on conflict (fingerprint) do update set
    count = case when public.rate_limits.day = excluded.day
                 then public.rate_limits.count + 1
                 else 1 end,
    day   = excluded.day
  returning *;
$$ language sql;

------------------------------------------------------------------------------
-- CROSS-CHANNEL QUEUES (Postgres replaces NanoClaw's SQLite IPC — see §3)
------------------------------------------------------------------------------

create table public.inbound_messages (
  id bigserial primary key,
  channel text not null check (channel in ('web','telegram')),
  session_id uuid references public.sessions(id),
  user_id uuid references public.users(id),
  content text not null,
  processed_at timestamptz,
  created_at timestamptz default now()
);
create index on public.inbound_messages (processed_at nulls first, created_at);

create table public.outbound_messages (
  id bigserial primary key,
  channel text not null check (channel in ('web','telegram')),
  session_id uuid references public.sessions(id),
  user_id uuid references public.users(id),
  telegram_chat_id bigint,
  content text not null,
  delivered_at timestamptz,
  created_at timestamptz default now()
);
create index on public.outbound_messages (channel, delivered_at nulls first, created_at);

------------------------------------------------------------------------------
-- ROW LEVEL SECURITY
------------------------------------------------------------------------------

alter table public.messages              enable row level security;
alter table public.thoughts              enable row level security;
alter table public.trade_recommendations enable row level security;
alter table public.entitlements          enable row level security;
alter table public.payments              enable row level security;

create policy thoughts_read_public on public.thoughts
  for select using (scope = 'public');

create policy thoughts_read_app on public.thoughts
  for select using (auth.role() = 'authenticated');

create policy messages_own on public.messages
  for select using (user_id = auth.uid());

create policy messages_insert_service on public.messages
  for insert with check (auth.role() = 'service_role');

create policy trades_read_all on public.trade_recommendations
  for select using (true);

create policy entitlements_own on public.entitlements
  for select using (
    user_id = auth.uid()
    or session_id::text = current_setting('request.headers', true)::json->>'x-zer0-session'
  );

create policy payments_own on public.payments
  for select using (user_id = auth.uid());

------------------------------------------------------------------------------
-- REALTIME REPLICATION (chain-of-thought streaming + outbound delivery)
------------------------------------------------------------------------------

alter publication supabase_realtime add table public.thoughts;
alter publication supabase_realtime add table public.trade_recommendations;
alter publication supabase_realtime add table public.outbound_messages;
