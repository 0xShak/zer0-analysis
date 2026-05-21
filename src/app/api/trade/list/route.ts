// GET /api/trade/list?address=0x... → recent trades for a wallet.
//
// The `trades` table's RLS only allows owners via auth.uid(), which most app
// users don't have (anon sessions). This route uses the admin client to
// return per-wallet trade activity. Wallet addresses are public on-chain, so
// returning trades keyed by address adds no information beyond what's
// already visible on Polymarket / Polygonscan — the requester just needs to
// know the address. We rate-limit to discourage scraping.

import type { NextRequest } from 'next/server';
import { utils as ethersUtils } from 'ethers';
import { createAdminClient } from '@/lib/supabase/admin';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { rateLimit, rateLimitKey } from '@/lib/trades/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('address');
  if (!raw) {
    return Response.json({ error: 'missing_address' }, { status: 400 });
  }

  let address: string;
  try {
    address = ethersUtils.getAddress(raw);
  } catch {
    return Response.json({ error: 'invalid_address' }, { status: 400 });
  }

  const ip = clientIpFromHeaders(req.headers);
  if (!rateLimit(rateLimitKey([address.toLowerCase(), ip, 'list']))) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }

  const supabase = createAdminClient();
  // Exclude 'pending' and 'prepared' — those are pre-submit internal states
  // that accumulate every time a user clicks execute and then cancels the
  // signature. They have no value in a user-facing activity feed.
  const { data, error } = await supabase
    .from('trades')
    .select(
      'id, market_condition_id, side, price, size_usd, status, clob_order_id, failure_reason, submitted_at, created_at, recommendation_id',
    )
    .ilike('user_address', address)
    .not('status', 'in', '(pending,prepared)')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[trade/list] query failed', error);
    return Response.json({ error: 'db_query_failed' }, { status: 500 });
  }

  const rows = data ?? [];
  // Second query: pull market_question for each referenced recommendation.
  // Two round-trips beats relying on Supabase's typed-client auto-detection
  // of the FK relation (which the generated types don't currently include).
  const recIds = Array.from(
    new Set(rows.map((r) => r.recommendation_id).filter((id): id is string => !!id)),
  );
  const questionByRec = new Map<string, string | null>();
  if (recIds.length) {
    const { data: recs } = await supabase
      .from('trade_recommendations')
      .select('id, market_question')
      .in('id', recIds);
    for (const r of recs ?? []) questionByRec.set(r.id, r.market_question);
  }

  const trades = rows.map((t) => ({
    id: t.id,
    market_condition_id: t.market_condition_id,
    market_question: t.recommendation_id
      ? questionByRec.get(t.recommendation_id) ?? null
      : null,
    side: t.side,
    price: t.price,
    size_usd: t.size_usd,
    status: t.status,
    clob_order_id: t.clob_order_id,
    failure_reason: t.failure_reason,
    submitted_at: t.submitted_at,
    created_at: t.created_at,
  }));

  return Response.json({ trades });
}
