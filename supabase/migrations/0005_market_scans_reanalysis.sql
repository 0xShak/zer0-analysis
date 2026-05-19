-- Re-analyze stale / price-moved markets. last_seen_at remains "when we last
-- saw it in a scan"; last_analyzed_at is "when we actually ran deep-analyze
-- on it" — different concepts. last_analyzed_yes_price lets us measure
-- price-movement-since-last-analysis.

alter table public.market_scans
  add column if not exists last_analyzed_at timestamptz,
  add column if not exists last_analyzed_yes_price numeric(5,4);

create index if not exists market_scans_last_analyzed_at_idx
  on public.market_scans (last_analyzed_at);
