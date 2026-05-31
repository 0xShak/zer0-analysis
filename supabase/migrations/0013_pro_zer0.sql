-- PRO unlock paid in $ZER0 on Base (replaces the Coinbase/USDC charge).
--
-- A user pays a USD-pegged amount of $ZER0 (≈ PRO_PRICE_USD worth, quoted at a
-- live price) on Base; we verify the transfer on-chain and grant a 30-day
-- entitlement keyed to the PAYER'S WALLET. Wallet-keying (not session-keying)
-- is deliberate: the payment is made on the separate landing site (zer0-FE),
-- a different origin with no shared zer0_sid cookie, so the only durable link
-- between "wallet that paid" and "user in the app" is the wallet address. The
-- chat gate resolves entitlement by the connected wallet → users.id.
--
-- Shape mirrors pending_sims' payment columns: a restart-safe order state
-- machine with idempotent on-chain settlement. The durable Inngest function
-- pro-verify-payment scans Base [from_block, tip] for the payer→sink transfer
-- and grants the entitlement the moment it lands, surviving wallet timeouts /
-- WC relay drops (the same robustness as sim-verify-payment).
--
-- service-role-only, like pending_sims: the browser only ever touches these
-- rows through the /api/pro/* admin-client routes.

create table public.pro_orders (
  id                uuid primary key default gen_random_uuid(),
  -- Payer wallet (lowercased EOA). The entitlement is granted to this wallet.
  wallet_address    text not null,
  -- Optional: the app session that initiated checkout, when paid from in-app.
  -- Landing-page payments leave this null (cross-origin, no shared session).
  session_id        uuid references public.sessions(id),
  state             text not null default 'AWAITING_PAYMENT'
                      check (state in ('AWAITING_PAYMENT','PAID','EXPIRED')),
  -- USD-pegged pricing, captured at quote time. amount_base_units is the EXACT
  -- $ZER0 transfer we expect (price_usd worth at quote-time price), in the
  -- token's base units; verification compares the on-chain transfer against it.
  price_usd         numeric(12,2) not null,
  price_zer0        numeric(38,18) not null,
  amount_base_units numeric(78,0) not null,
  token_address     text not null,
  pay_to_address    text not null,
  -- Base chain tip captured when the order was quoted — the durable scanner's
  -- lower bound, so it only inspects blocks from here forward.
  from_block        numeric(78,0) not null,
  pay_tx_hash       text,
  paid_at           timestamptz,
  entitlement_id    uuid references public.entitlements(id),
  error             text,
  expires_at        timestamptz not null default (now() + interval '20 minutes'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index pro_orders_wallet_state_idx on public.pro_orders(wallet_address, state);
create index pro_orders_state_expires_idx on public.pro_orders(state, expires_at);
-- Idempotency: one confirmed payment tx can fund at most one PRO order.
create unique index pro_orders_pay_tx_idx
  on public.pro_orders(pay_tx_hash) where pay_tx_hash is not null;

alter table public.pro_orders enable row level security;
-- service_role only — no CREATE POLICY (matches pending_sims / entitlements).
