-- Per-Telegram-user Polymarket CLOB L2 API credentials.
--
-- The bot used to authenticate EVERY user's order with one shared, relay-derived
-- API key. Polymarket V2 requires the api-key's bound address to equal the
-- order's `signer`, so a shared key can't satisfy arbitrary users — the CLOB
-- rejects with "the order signer address has to be the address of the api key".
--
-- At /connect we now derive a per-user L2 key (one extra WalletConnect signature
-- over Polymarket's ClobAuth EIP-712 message), bound to the user's trading-wallet
-- signer address, and store it here. post-order.ts authenticates with this row.
--
-- These columns are SECRETS (same sensitivity as the env relay creds). The table
-- is write-locked to the service role — the bot connects with SUPABASE_SERVICE_KEY
-- (createAdminClient). No CREATE POLICY → anon/authenticated can never read them.

create table public.tg_clob_api_creds (
  telegram_user_id bigint primary key,
  signer_address   text not null,
  api_key          text not null,
  api_secret       text not null,
  api_passphrase   text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.tg_clob_api_creds enable row level security;
-- No CREATE POLICY → service_role only.
