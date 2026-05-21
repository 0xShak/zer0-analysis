// POST /api/trade/notify — record the outcome of a client-side Polymarket
// submission so the trades table reflects what really happened.
//
// We moved order submission to the browser to bypass Polymarket's IP
// geoblock (US-pinned Vercel functions get rejected). The client posts
// directly to Polymarket's CLOB; this endpoint just persists the outcome
// for /api/trade/list + RecentTradesBubble to read. No Polymarket calls
// happen here.
//
// Trust model: each user signs orders with their own EOA, so they can
// only affect their own balance. The worst a malicious client could do
// by lying about the outcome is mislabel their own RecentTradesBubble
// row. Acceptable for v1; tighter verification can come later.

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { rateLimit, rateLimitKey } from '@/lib/trades/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NotifyBody = z.object({
  tradeId: z.string().regex(UUID_RE, 'tradeId must be uuid'),
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('filled'),
      clobOrderId: z.string().nullable(),
      txHashes: z.array(z.string()).default([]),
      sizeMatched: z.string().optional(),
      clobStatus: z.string().optional(),
    }),
    z.object({
      kind: z.literal('cancelled'),
      clobOrderId: z.string().nullable().optional(),
      reason: z.string().max(1000),
    }),
    z.object({
      kind: z.literal('rejected'),
      reason: z.string().max(1000),
    }),
  ]),
});

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = NotifyBody.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { tradeId, outcome } = parsed.data;

  const ip = clientIpFromHeaders(req.headers);
  if (!rateLimit(rateLimitKey([ip, tradeId, 'notify']))) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }

  const supabase = createAdminClient();
  const { data: trade, error: tradeErr } = await supabase
    .from('trades')
    .select('id, status')
    .eq('id', tradeId)
    .maybeSingle();
  if (tradeErr) {
    console.error('[trade/notify] trade lookup failed', tradeErr);
    return Response.json({ error: 'db_lookup_failed' }, { status: 500 });
  }
  if (!trade) {
    return Response.json({ error: 'trade_not_found' }, { status: 404 });
  }
  // Idempotency: don't overwrite an already-terminal status (the client
  // can re-send the notify; we only allow first-write to a terminal state).
  const terminal = ['filled', 'submitted', 'accepted', 'rejected', 'cancelled', 'failed'];
  if (terminal.includes(trade.status)) {
    return Response.json(
      { ok: true, alreadyTerminal: true, status: trade.status },
      { status: 200 },
    );
  }
  if (trade.status !== 'prepared') {
    return Response.json(
      { error: 'trade_not_in_prepared_state', currentStatus: trade.status },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  if (outcome.kind === 'filled') {
    const { error: updErr } = await supabase
      .from('trades')
      .update({
        status: 'filled',
        clob_order_id: outcome.clobOrderId,
        submitted_at: now,
        filled_at: now,
        failure_reason: null,
      })
      .eq('id', tradeId);
    if (updErr) {
      console.error('[trade/notify] update failed (filled)', updErr);
      return Response.json({ error: 'db_update_failed' }, { status: 500 });
    }
    console.log('[trade/notify] filled', {
      tradeId,
      clobOrderId: outcome.clobOrderId,
      sizeMatched: outcome.sizeMatched,
      clobStatus: outcome.clobStatus,
      txHashes: outcome.txHashes.length,
    });
    return Response.json({ ok: true, status: 'filled' });
  }

  if (outcome.kind === 'cancelled') {
    const { error: updErr } = await supabase
      .from('trades')
      .update({
        status: 'cancelled',
        clob_order_id: outcome.clobOrderId ?? null,
        submitted_at: now,
        failure_reason: outcome.reason.slice(0, 1000),
      })
      .eq('id', tradeId);
    if (updErr) {
      console.error('[trade/notify] update failed (cancelled)', updErr);
      return Response.json({ error: 'db_update_failed' }, { status: 500 });
    }
    console.log('[trade/notify] cancelled', { tradeId, reason: outcome.reason });
    return Response.json({ ok: true, status: 'cancelled' });
  }

  // rejected
  const { error: updErr } = await supabase
    .from('trades')
    .update({
      status: 'rejected',
      failure_reason: outcome.reason.slice(0, 1000),
    })
    .eq('id', tradeId);
  if (updErr) {
    console.error('[trade/notify] update failed (rejected)', updErr);
    return Response.json({ error: 'db_update_failed' }, { status: 500 });
  }
  console.log('[trade/notify] rejected', { tradeId, reason: outcome.reason });
  return Response.json({ ok: true, status: 'rejected' });
}
