-- Trade execution table — see zer0.md §8 / §13 (Day 5).
--
-- Two-phase non-custodial flow:
--   1. POST /api/trade/prepare inserts a row with status='prepared' and the
--      unsigned EIP-712 payload in `order_payload`.
--   2. POST /api/trade/submit attaches the user's signed order, forwards to
--      Polymarket CLOB, and transitions status → 'submitted' / 'rejected'.

create table public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id),
  session_id uuid references public.sessions(id),
  recommendation_id uuid references public.trade_recommendations(id),
  user_address text not null,
  market_condition_id text not null,
  token_id text not null,
  side text not null check (side in ('BUY','SELL')),
  price numeric(5,4) not null,
  size_usd numeric(18,6) not null,
  signature_type int not null check (signature_type in (0,1,2,3)),
  order_payload jsonb,         -- unsigned EIP-712 from prepare
  signed_order jsonb,          -- full signed order from client
  status text default 'pending' check (status in (
    'pending','prepared','submitted','accepted','rejected','filled','cancelled','failed'
  )),
  clob_order_id text,
  failure_reason text,
  prepared_at timestamptz default now(),
  submitted_at timestamptz,
  accepted_at timestamptz,
  filled_at timestamptz,
  created_at timestamptz default now()
);

create index trades_user_id_idx on public.trades (user_id, created_at desc);
create index trades_status_idx  on public.trades (status, prepared_at desc);

alter table public.trades enable row level security;

-- Service role does everything via createAdminClient(); users may SELECT
-- their own rows once Supabase Auth is wired into the trade routes.
create policy trades_own on public.trades
  for select using (user_id = auth.uid());
