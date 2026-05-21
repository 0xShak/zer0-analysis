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

  // ---- soft-rejection detection ----
  // Polymarket SDK's postOrder resolves (does NOT throw) with
  // { success: false, errorMsg } when the API rejects an order — bad
  // signature, insufficient balance, missing CTF allowance, etc. Without
  // this check we'd record a phantom 'submitted' with clob_order_id=null.
  const resultObj =
    typeof clobResult === 'object' && clobResult !== null
      ? (clobResult as Record<string, unknown>)
      : {};
  if (resultObj.success === false) {
    const errorMsg =
      typeof resultObj.errorMsg === 'string' && resultObj.errorMsg
        ? resultObj.errorMsg
        : 'CLOB rejected order';
    console.error('[trade/submit] CLOB soft-rejection', { tradeId, errorMsg });
    await supabase
      .from('trades')
      .update({
        status: 'rejected',
        failure_reason: errorMsg.slice(0, 1000),
        signed_order: sdkOrder as unknown as Json,
      })
      .eq('id', tradeId);
    return Response.json(
      { error: 'clob_rejected', reason: errorMsg },
      { status: 422 },
    );
  }

  // ---- success ----
  const clobOrderId =
    (typeof resultObj.orderID === 'string' && resultObj.orderID) ||
    (typeof resultObj.orderId === 'string' && resultObj.orderId) ||
    null;
  if (!clobOrderId) {
    console.warn('[trade/submit] CLOB success without orderID', {
      tradeId,
      shape: Object.keys(resultObj),
    });
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('trades')
    .update({
      status: 'submitted',
      clob_order_id: clobOrderId,
      signed_order: sdkOrder as unknown as Json,
      submitted_at: now,
    })
    .eq('id', tradeId);
  if (updateErr) {
    console.error('[trade/submit] trades update failed', updateErr);
  }

  // NOTE: We do NOT write a `thoughts` row for trade submissions. The
  // thoughts table has no per-user column and its RLS policy exposes all
  // scope='app' rows to every authenticated client (including the public
  // anon key in the browser bundle). Per-user trade activity is surfaced
  // via /api/trade/list + RecentTradesBubble instead.

  return Response.json({
    tradeId,
    clobOrderId,
    status: 'submitted',
    submittedAt: now,
  });
}
