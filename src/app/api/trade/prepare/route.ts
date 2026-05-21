// TODO(v1.1): For signature_type=0 (EOA) users on first trade, frontend must
// check USDC.e + CTF allowances and prompt approval txs BEFORE calling
// /api/trade/submit. We surface no warning from the backend.

import type { NextRequest } from 'next/server';
import { utils as ethersUtils } from 'ethers';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/database.types';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { rateLimit, rateLimitKey } from '@/lib/trades/rate-limit';
import { PrepareBody } from '@/lib/trades/validators';
import {
  buildTypedData,
  getBookContext,
  getMarketMeta,
} from '@/lib/polymarket/clob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = PrepareBody.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { recommendationId, signatureType, sizeOverrideUsd } = parsed.data;

  let userAddress: string;
  try {
    userAddress = ethersUtils.getAddress(parsed.data.userAddress);
  } catch {
    return Response.json({ error: 'invalid_user_address' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ---- session from zer0_sid cookie (same pattern as /api/chat) ----
  const cookieSid = req.cookies.get('zer0_sid')?.value;
  const sid = cookieSid && UUID_RE.test(cookieSid) ? cookieSid : null;

  // ---- optional auth via bearer token ----
  let userId: string | null = null;
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data.user) userId = data.user.id;
    }
  }

  // ---- rate limit (30/min per user+IP) ----
  const ip = clientIpFromHeaders(req.headers);
  if (!rateLimit(rateLimitKey([userId, ip, 'prepare']))) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }

  // ---- look up recommendation ----
  const { data: rec, error: recErr } = await supabase
    .from('trade_recommendations')
    .select('*')
    .eq('id', recommendationId)
    .single();
  if (recErr || !rec) {
    return Response.json({ error: 'recommendation_not_found' }, { status: 404 });
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

  // ---- session resolution (look up by sid cookie OR user_id) ----
  let sessionId: string | null = null;
  if (sid) {
    const { data: s } = await supabase
      .from('sessions')
      .select('id')
      .eq('id', sid)
      .limit(1)
      .maybeSingle();
    if (s) sessionId = s.id;
  }
  if (!sessionId && userId) {
    const { data: s } = await supabase
      .from('sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('channel', 'web')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (s) sessionId = s.id;
  }

  // ---- market meta (negRisk, tickSize) — falls back to rec.neg_risk on failure ----
  let negRisk = Boolean(rec.neg_risk);
  let tickSize: '0.1' | '0.01' | '0.001' | '0.0001' = '0.01';
  let question: string = rec.market_question ?? '';
  try {
    const meta = await getMarketMeta(rec.market_condition_id);
    negRisk = meta.negRisk;
    tickSize = meta.tickSize;
    if (meta.question) question = meta.question;
  } catch (err) {
    // CLOB getMarket failures are non-fatal — we fall back to recommendation
    // defaults. Log structural metadata only (no order payload).
    console.error('[trade/prepare] getMarket failed', {
      conditionId: rec.market_condition_id,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const sizeUsd = sizeOverrideUsd ?? Number(rec.size);
  const recPrice = Number(rec.price);
  if (!Number.isFinite(recPrice) || recPrice <= 0) {
    return Response.json({ error: 'invalid_recommendation_price' }, { status: 500 });
  }

  // We submit as FAK (fill-and-kill) so trades either settle on-chain
  // immediately or fail with a real reason — no resting limbo. For that
  // semantic to actually result in a fill, we have to price at (or beyond)
  // the opposite side of the order book. BUY → best ask, SELL → best bid.
  // We fall back to the recommendation price if the book lookup fails;
  // that order will likely no-fill but at least won't crash prepare.
  let price = recPrice;
  let bookPrice: number | null = null;
  let minOrderSize = 0;
  try {
    const ctx = await getBookContext(rec.token_id, rec.side);
    if (ctx) {
      bookPrice = ctx.bestPrice;
      minOrderSize = ctx.minOrderSize;
      if (bookPrice !== null) price = bookPrice;
    }
  } catch (err) {
    console.warn('[trade/prepare] order-book lookup failed', {
      tokenId: rec.token_id,
      side: rec.side,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Polymarket SDK's `size` is SHARES, not USD. shares = USD / price so the
  // user's stated USD notional becomes the order's USDC leg. Uses the
  // execution price (not the recommendation price) so shares-vs-USDC stay
  // consistent with what will actually be quoted on-chain.
  const sizeShares = sizeUsd / price;

  // Guard against orders Polymarket will reject for being too small. Their
  // per-market min_order_size (returned from /book) is enforced server-
  // side; failing here gives the user an actionable message before any
  // wallet popup, and prevents the post-submit "cancelled (unmatched)"
  // case that we can't easily distinguish from a real no-fill.
  if (minOrderSize > 0 && sizeShares < minOrderSize) {
    const suggestedMinUsd =
      Math.ceil(minOrderSize * price * 100) / 100;
    return Response.json(
      {
        error: 'below_min_size',
        detail: `market requires at least ${minOrderSize} shares per order — try a USD size of $${suggestedMinUsd.toFixed(2)} or more`,
        minOrderSize,
        suggestedMinUsd,
      },
      { status: 400 },
    );
  }

  // ---- build typed data ----
  let typedData;
  try {
    typedData = await buildTypedData({
      tokenId: rec.token_id,
      price,
      size: sizeShares,
      side: rec.side,
      maker: userAddress,
      taker: '0x0000000000000000000000000000000000000000',
      feeRateBps: 0,
      signatureType,
      tickSize,
      negRisk,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('[trade/prepare] buildTypedData failed', message, stack);
    return Response.json({ error: 'clob_unavailable', detail: message }, { status: 500 });
  }

  // ---- insert trades row (status='prepared', payload sans signature) ----
  const { data: inserted, error: insertErr } = await supabase
    .from('trades')
    .insert({
      user_id: userId,
      session_id: sessionId,
      recommendation_id: rec.id,
      user_address: userAddress,
      market_condition_id: rec.market_condition_id,
      token_id: rec.token_id,
      side: rec.side,
      price,
      size_usd: sizeUsd,
      signature_type: signatureType,
      order_payload: typedData as unknown as Json,
      status: 'prepared',
    })
    .select('id')
    .single();
  if (insertErr || !inserted) {
    console.error('[trade/prepare] trades insert failed', insertErr);
    return Response.json({ error: 'db_insert_failed' }, { status: 500 });
  }

  return Response.json({
    tradeId: inserted.id,
    typedData,
    expiresAt: rec.expires_at,
    market: {
      question,
      condition_id: rec.market_condition_id,
    },
    // Execution metadata for the UI: tells the user the order will fill at
    // the live book price, not the analyst's signal price.
    execution: {
      executionPrice: price,
      recommendationPrice: recPrice,
      bookPrice,
      orderType: 'FAK',
    },
  });
}
