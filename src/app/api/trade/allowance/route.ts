// GET /api/trade/allowance?address=0x...&recommendationId=<uuid>
//
// Preflight read of the user's USDC.e allowance to the Polymarket Exchange
// (and CTF setApprovalForAll status, used only for SELL). Lets the
// TradeCard surface a "first-time setup" hint and run the approve tx
// before signing an order Polymarket would otherwise reject for
// insufficient allowance.

import type { NextRequest } from 'next/server';
import { utils as ethersUtils } from 'ethers';
import { createAdminClient } from '@/lib/supabase/admin';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { rateLimit, rateLimitKey } from '@/lib/trades/rate-limit';
import {
  AllRpcsFailedError,
  getCollateralAllowance,
  isCtfApprovedForAll,
} from '@/lib/polymarket/allowance';
import {
  CONDITIONAL_TOKENS,
  USDC_E_ADDRESS,
  exchangeForMarket,
} from '@/lib/polymarket/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const rawAddress = req.nextUrl.searchParams.get('address');
  if (!rawAddress) {
    return Response.json({ error: 'missing_address' }, { status: 400 });
  }
  let address: string;
  try {
    address = ethersUtils.getAddress(rawAddress);
  } catch {
    return Response.json({ error: 'invalid_address' }, { status: 400 });
  }

  const ip = clientIpFromHeaders(req.headers);
  if (!rateLimit(rateLimitKey([address.toLowerCase(), ip, 'allowance']))) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }

  // Optional: look up the recommendation's neg_risk flag so we know which
  // Exchange contract is the spender. Falls back to the regular CTF
  // Exchange if the recommendation can't be resolved (good enough for the
  // common case; client can re-fetch with a specific id later).
  let negRisk = false;
  const recId = req.nextUrl.searchParams.get('recommendationId');
  if (recId && UUID_RE.test(recId)) {
    const supabase = createAdminClient();
    const { data: rec } = await supabase
      .from('trade_recommendations')
      .select('neg_risk')
      .eq('id', recId)
      .maybeSingle();
    if (rec) negRisk = Boolean(rec.neg_risk);
  }

  const spender = exchangeForMarket(negRisk) as `0x${string}`;
  const owner = address as `0x${string}`;

  let allowance: bigint;
  let ctfApproved: boolean;
  try {
    [allowance, ctfApproved] = await Promise.all([
      getCollateralAllowance(owner, spender),
      isCtfApprovedForAll(owner, spender),
    ]);
  } catch (err) {
    // All fallback RPCs failed. Return 200 with `unknown: true` so the
    // client can decide whether to surface a soft warning vs hard error;
    // returning 503 here meant the user got NO approval prompt and the
    // order silently proceeded without allowance.
    if (err instanceof AllRpcsFailedError) {
      console.warn('[trade/allowance] all RPCs failed', err.attempts);
    } else {
      console.error('[trade/allowance] RPC read failed', err);
    }
    return Response.json({
      unknown: true,
      usdc: { spender, token: USDC_E_ADDRESS },
      ctf: { spender, token: CONDITIONAL_TOKENS },
      exchange: { negRisk },
    });
  }

  return Response.json({
    usdc: {
      allowance: allowance.toString(),
      spender,
      token: USDC_E_ADDRESS,
    },
    ctf: {
      approved: ctfApproved,
      spender,
      token: CONDITIONAL_TOKENS,
    },
    exchange: { negRisk },
  });
}
