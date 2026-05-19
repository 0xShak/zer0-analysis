import type { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/database.types';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { rateLimit, rateLimitKey } from '@/lib/trades/rate-limit';
import { SubmitBody } from '@/lib/trades/validators';
import { postSignedOrder, OrderType } from '@/lib/polymarket/clob';
import type { SignedOrder } from '@polymarket/clob-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = SubmitBody.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { tradeId, signedOrder } = parsed.data;

  const supabase = createAdminClient();

  // ---- optional auth via bearer token (for rate-limit keying + thoughts) ----
  let userId: string | null = null;
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data.user) userId = data.user.id;
    }
  }

  const ip = clientIpFromHeaders(req.headers);
  if (!rateLimit(rateLimitKey([userId, ip, 'submit']))) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }

  // ---- load the trade row ----
  const { data: trade, error: tradeErr } = await supabase
    .from('trades')
    .select('*')
    .eq('id', tradeId)
    .maybeSingle();
  if (tradeErr) {
    console.error('[trade/submit] trade lookup failed', tradeErr);
    return Response.json({ error: 'db_lookup_failed' }, { status: 500 });
  }
  if (!trade) {
    return Response.json({ error: 'trade_not_found' }, { status: 404 });
  }

  // Idempotency — already in flight or settled.
  if (
    trade.status === 'submitted' ||
    trade.status === 'accepted' ||
    trade.status === 'filled'
  ) {
    return Response.json(
      {
        error: 'already_submitted',
        tradeId: trade.id,
        status: trade.status,
        clobOrderId: trade.clob_order_id,
      },
      { status: 409 },
    );
  }
  if (trade.status !== 'prepared') {
    return Response.json(
      { error: 'trade_not_prepared', status: trade.status },
      { status: 409 },
    );
  }

  // Maker must match the address from prepare.
  if (trade.user_address.toLowerCase() !== signedOrder.maker.toLowerCase()) {
    return Response.json({ error: 'maker_mismatch' }, { status: 403 });
  }

  // ---- recommendation still valid? ----
  if (trade.recommendation_id) {
    const { data: rec } = await supabase
      .from('trade_recommendations')
      .select('status, expires_at, market_question')
      .eq('id', trade.recommendation_id)
      .maybeSingle();
    if (!rec) {
      return Response.json({ error: 'recommendation_missing' }, { status: 410 });
    }
    if (rec.status !== 'open') {
      return Response.json(
        { error: 'recommendation_not_open', status: rec.status },
        { status: 410 },
      );
    }
    if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) {
      return Response.json({ error: 'recommendation_expired' }, { status: 410 });
    }
  }

  // ---- forward to CLOB ----
  // The SDK's SignedOrder.side is a Side enum (BUY/SELL strings). Our zod
  // schema lets through 0/1 too (per CTF on-chain numeric encoding) — for
  // safety, normalise back to the string form the SDK expects.
  const normalisedSide =
    signedOrder.side === 'BUY' || signedOrder.side === 0
      ? 'BUY'
      : 'SELL';
  const sdkOrder = {
    ...signedOrder,
    salt: String(signedOrder.salt),
    expiration: String(signedOrder.expiration),
    nonce: String(signedOrder.nonce),
    feeRateBps: String(signedOrder.feeRateBps),
    side: normalisedSide,
  } as unknown as SignedOrder;

  let clobResult: unknown;
  try {
    clobResult = await postSignedOrder(sdkOrder, OrderType.GTC);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[trade/submit] CLOB error', { tradeId, message });
    // Distinguish CLOB rejection (4xx body) from transport failure.
    const isNetwork =
      /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(message);
    if (isNetwork) {
      return Response.json(
        { error: 'clob_unreachable', retry: true },
        { status: 503 },
      );
    }
    await supabase
      .from('trades')
      .update({
        status: 'rejected',
        failure_reason: message.slice(0, 1000),
        signed_order: sdkOrder as unknown as Json,
      })
      .eq('id', tradeId);
    return Response.json(
      { error: 'clob_rejected', reason: message },
      { status: 422 },
    );
  }

  // ---- success ----
  const clobOrderId =
    (typeof clobResult === 'object' &&
      clobResult !== null &&
      'orderID' in (clobResult as Record<string, unknown>) &&
      String((clobResult as Record<string, unknown>).orderID)) ||
    (typeof clobResult === 'object' &&
      clobResult !== null &&
      'orderId' in (clobResult as Record<string, unknown>) &&
      String((clobResult as Record<string, unknown>).orderId)) ||
    null;

  const accepted =
    typeof clobResult === 'object' &&
    clobResult !== null &&
    'success' in (clobResult as Record<string, unknown>) &&
    (clobResult as Record<string, unknown>).success !== false;

  const nextStatus = accepted ? 'submitted' : 'submitted';
  const now = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from('trades')
    .update({
      status: nextStatus,
      clob_order_id: clobOrderId,
      signed_order: sdkOrder as unknown as Json,
      submitted_at: now,
    })
    .eq('id', tradeId);
  if (updateErr) {
    console.error('[trade/submit] trades update failed', updateErr);
  }

  // ---- emit an app-scope thought (observability) ----
  try {
    let question = '';
    if (trade.recommendation_id) {
      const { data: rec } = await supabase
        .from('trade_recommendations')
        .select('market_question')
        .eq('id', trade.recommendation_id)
        .maybeSingle();
      question = rec?.market_question ?? '';
    }
    await supabase.from('thoughts').insert({
      scope: 'app',
      market_condition_id: trade.market_condition_id,
      content: `Submitted trade on "${question}" — ${trade.side} @ ${trade.price}, size $${trade.size_usd}. CLOB order ${clobOrderId ?? 'unknown'}.`,
    });
  } catch (err) {
    console.error('[trade/submit] thought insert failed', err);
  }

  return Response.json({
    tradeId,
    clobOrderId,
    status: nextStatus,
    submittedAt: now,
  });
}
