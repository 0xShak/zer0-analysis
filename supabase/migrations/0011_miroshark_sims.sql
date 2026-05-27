-- MiroShark × ZER0 — run-a-sim integration (see miroshark-zero.html §6 Track A).
--
-- Two tables mirror the existing pending_trades / trades split:
--
--   pending_sims  — the request + pay-per-sim gate state machine. A user asks
--                   to run a swarm sim (Telegram /sim or the web form); we quote
--                   a price, wait for $ZER0 payment on Base (when the payment
--                   gate is enabled), then enqueue sim/requested. Restart-safe,
--                   like tg_pending_trades.
--
--   simulations   — one row per run that actually fired. The Inngest sim-run
--                   function (executes on Vercel) drives the MiroShark lifecycle
--                   and writes results (watch URL, share card, signal/polymarket
--                   JSON, a short summary) back here.
--
-- Both are service-role-only (the bot + Inngest fns use SUPABASE_SERVICE_KEY /
-- createAdminClient). The web result view reads simulations through an API
-- route that uses the admin client, so anon/auth browser clients never touch
-- these rows directly.

------------------------------------------------------------------------------
-- Shared lifecycle enum
------------------------------------------------------------------------------

create type public.sim_state as enum (
  'AWAITING_PAYMENT', -- quoted, waiting for the on-chain $ZER0 transfer
  'PAID',             -- payment verified (or free run); ready to enqueue
  'RUNNING',          -- sim-run picked it up and is driving MiroShark
  'COMPLETED',        -- results fetched + delivered
  'FAILED',           -- MiroShark or orchestration error (terminal)
  'EXPIRED',          -- payment window elapsed with no valid tx
  'CANCELLED'         -- user backed out
);

------------------------------------------------------------------------------
-- 1. pending_sims  —  request + payment gate, restart-safe.
------------------------------------------------------------------------------

create table public.pending_sims (
  id                uuid primary key default gen_random_uuid(),
  channel           text not null check (channel in ('web','telegram')),
  user_id           uuid references public.users(id),
  session_id        uuid references public.sessions(id),
  -- Telegram routing (null for web). chat id is where the bot replies; the
  -- user id authenticates the payment callback, mirroring tg_pending_trades.
  telegram_user_id  bigint,
  telegram_chat_id  bigint,
  -- The raw sentence the user typed — fed to MiroShark as the scenario text.
  scenario          text not null,
  state             public.sim_state not null default 'AWAITING_PAYMENT',
  -- Pay-per-sim bookkeeping. price_zer0 is the human-readable $ZER0 amount we
  -- quoted; verification compares on-chain base units against ZER0_SIM_PRICE.
  price_zer0        numeric(38,18),
  pay_to_address    text,
  pay_tx_hash       text,
  paid_at           timestamptz,
  error             text,
  expires_at        timestamptz not null default (now() + interval '15 minutes'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index pending_sims_user_state_idx on public.pending_sims(telegram_user_id, state);
create index pending_sims_state_expires_idx on public.pending_sims(state, expires_at);
-- Idempotency: a confirmed payment tx can only fund one sim.
create unique index pending_sims_pay_tx_idx
  on public.pending_sims(pay_tx_hash) where pay_tx_hash is not null;

alter table public.pending_sims enable row level security;
-- service_role only — no CREATE POLICY.

------------------------------------------------------------------------------
-- 2. simulations  —  one row per fired run + its results.
------------------------------------------------------------------------------

create table public.simulations (
  id                     uuid primary key default gen_random_uuid(),
  pending_sim_id         uuid references public.pending_sims(id),
  channel                text not null check (channel in ('web','telegram')),
  user_id                uuid references public.users(id),
  session_id             uuid references public.sessions(id),
  telegram_chat_id       bigint,
  scenario               text not null,
  status                 public.sim_state not null default 'RUNNING',
  -- MiroShark-side identifiers, captured as the lifecycle advances.
  miroshark_project_id   text,
  miroshark_graph_id     text,
  miroshark_simulation_id text,
  -- Result artifacts. watch_url + share_card_url are MiroShark's own pages
  -- (v1 reuses them — zero custom UI). signal/polymarket JSON are the raw
  -- result blobs; summary is the short LLM-written digest we deliver.
  watch_url              text,
  share_card_url         text,
  signal_json            jsonb,
  polymarket_json        jsonb,
  summary                text,
  error                  text,
  wall_clock_ms          integer,
  created_at             timestamptz not null default now(),
  completed_at           timestamptz
);
-- One simulation per pending_sim (the orchestrator creates it once).
create unique index simulations_pending_sim_idx
  on public.simulations(pending_sim_id) where pending_sim_id is not null;
create index simulations_user_idx on public.simulations(user_id, created_at desc);
create index simulations_status_idx on public.simulations(status, created_at desc);

alter table public.simulations enable row level security;
-- service_role only — the web result view reads via an admin-client API route.
