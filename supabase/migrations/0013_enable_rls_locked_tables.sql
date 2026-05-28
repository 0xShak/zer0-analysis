-- Close the RLS gap left by 0001 (audit2.md C1).
--
-- 0001 enabled RLS on only 5 of its 11 tables. The 6 below were created with
-- RLS OFF and the project sets no table GRANTs, so Supabase's default grants
-- (anon + authenticated get full CRUD on public tables; RLS is the only gate)
-- left them fully readable AND writable via the browser-exposed anon key. That
-- allowed anon to dump users/sessions, exfiltrate + spoof outbound_messages
-- (the Telegram bot delivers any inserted row → phishing relay), reset the
-- rate_limits counter (defeating the daily cap), and poison market_scans.
--
-- All six are accessed server-side via the service-role admin client
-- (createAdminClient), which BYPASSES RLS — so enabling RLS-with-no-policy does
-- not affect the bot, the Inngest functions, or the API routes. The only anon
-- (browser) reader of any of these tables is ChatHeader.tsx reading
-- market_scans, so that one table keeps a read-only policy; the rest are
-- service-role-only (no policy = denied to anon/authenticated).

alter table public.users             enable row level security;
alter table public.sessions          enable row level security;
alter table public.market_scans      enable row level security;
alter table public.rate_limits       enable row level security;
alter table public.inbound_messages  enable row level security;
alter table public.outbound_messages enable row level security;

-- market_scans is read by the public app (ChatHeader.tsx) via the anon client.
-- Read-only, non-sensitive market metadata + ZER0's classification. No INSERT/
-- UPDATE/DELETE policy → anon still cannot write (closes the brain-poison write
-- vector while preserving the client read). Service-role writes bypass RLS.
create policy market_scans_read on public.market_scans
  for select using (true);
