-- Telegram v3 — conversational trading.
--
-- Three new tables to support /connect (WalletConnect session), the
-- inline-keyboard Confirm state machine (pending trades), and the
-- WalletConnect SignClient's IKeyValueStorage backing.
--
-- All three are write-locked to the service role. The bot connects with
-- SUPABASE_SERVICE_KEY (createAdminClient), so it can read/write freely;
-- anon and authenticated browser clients should never touch these rows.
-- Session topics are auth secrets (equivalent to a refresh token), so the
-- RLS is deny-all for non-service roles.

------------------------------------------------------------------------------
-- 1. tg_wc_sessions  —  per-Telegram-user WalletConnect session pointer.
------------------------------------------------------------------------------

create table public.tg_wc_sessions (
  telegram_user_id  bigint  primary key,
  session_topic     text    not null,
  eoa_address       text    not null,
  funder_address    text    not null,
  signature_type    smallint not null check (signature_type in (0,1,2,3)),
  wallet_type       text     not null check (wallet_type in ('eoa','proxy','safe','deposit_wallet')),
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz not null default now()
);
create index tg_wc_sessions_topic_idx on public.tg_wc_sessions(session_topic);

alter table public.tg_wc_sessions enable row level security;
-- No CREATE POLICY → no role except service_role can read or write.

------------------------------------------------------------------------------
-- 2. tg_pending_trades  —  Confirm state machine, restart-safe.
------------------------------------------------------------------------------

create type public.tg_trade_state as enum (
  'INTENT_PARSED',
  'AWAITING_USER_CONFIRM',
  'AWAITING_WALLET_SIG',
  'SUBMITTED',
  'DONE',
  'CANCELLED',
  'EXPIRED'
);

create table public.tg_pending_trades (
  id               uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  chat_id          bigint not null,
  message_id       bigint,
  state            public.tg_trade_state not null,
  trade_id         uuid,
  intent_json      jsonb not null,
  typed_data       jsonb,
  wallet_meta      jsonb,
  expires_at       timestamptz not null default (now() + interval '90 seconds'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index tg_pending_trades_user_state_idx
  on public.tg_pending_trades(telegram_user_id, state);
create index tg_pending_trades_expires_idx
  on public.tg_pending_trades(expires_at);

alter table public.tg_pending_trades enable row level security;
-- service_role only.

------------------------------------------------------------------------------
-- 3. walletconnect_kv  —  IKeyValueStorage backing for SignClient.
------------------------------------------------------------------------------
--
-- WalletConnect's SignClient persists its session/relayer state through a
-- pluggable storage interface. We back it with Postgres so the bot survives
-- PM2 restarts and we sidestep the better-sqlite3 native-build pitfall on
-- Oracle ARM. Values are JSON because the SDK encodes them itself.

create table public.walletconnect_kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.walletconnect_kv enable row level security;
-- service_role only.
