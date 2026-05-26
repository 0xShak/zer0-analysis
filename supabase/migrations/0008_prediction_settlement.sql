-- Prediction settlement + track record.
--
-- trade_recommendations are inserted with status='open' and, until now, never
-- revisited. This migration adds the columns the settlement job
-- (settle-predictions.ts) writes once a market resolves, plus mark-to-market
-- columns refreshed every settle run while a call is still open. Together they
-- back the /app/stats track-record dashboard.
--
-- Resolution columns (set once, when the market resolves):
--   resolved_at        when we recorded the resolution
--   winning_token_id   the clobTokenId that resolved to ~1
--   resolution_price   that token's final price (~1)
--   is_correct         did ZER0's side/token bet hit?
--   realized_pnl_usd   hypothetical paper PnL at the suggested price/size
--
-- Mark-to-market columns (refreshed each settle run while status='open'):
--   mark_price         current price of the rec's own token
--   mark_pnl_usd       unrealized paper PnL at that price
--   settled_at         last time the settle job touched this row

alter table public.trade_recommendations
  add column if not exists resolved_at timestamptz,
  add column if not exists winning_token_id text,
  add column if not exists resolution_price numeric(5,4),
  add column if not exists is_correct boolean,
  add column if not exists realized_pnl_usd numeric(18,6),
  add column if not exists mark_price numeric(5,4),
  add column if not exists mark_pnl_usd numeric(18,6),
  add column if not exists settled_at timestamptz;

-- status now transitions open -> won | lost | void. 'void' = market resolved
-- ambiguously (50/50 refund) or couldn't be scored; excluded from accuracy.
alter table public.trade_recommendations
  drop constraint if exists trade_recommendations_status_check;
alter table public.trade_recommendations
  add constraint trade_recommendations_status_check
  check (status in ('open','won','lost','void'));

-- The settle job scans open rows; the dashboard reads resolved rows by date.
create index if not exists trade_recommendations_status_resolved_idx
  on public.trade_recommendations (status, resolved_at desc);
