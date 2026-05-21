// GET /api/trade/allowance?address=0x...&recommendationId=<uuid>
//
// Preflight read of everything the TradeCard needs to decide which first-
// trade setup steps to drive: pUSD balance + V2 Exchange allowance, USDC.e
// balance + Onramp allowance (for wrapping), and CTF setApprovalForAll
// status (used only for SELL). Lets the UI prompt the user through
// USDC.e → wrap → pUSD approve → sign before touching the order.

import type { NextRequest } from 'next/server';
import { utils as ethersUtils } from 'ethers';
import { createAdminClient } from '@/lib/supabase/admin';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { rateLimit, rateLimitKey } from '@/lib/trades/rate-limit';
import {
  AllRpcsFailedError,
  getPusdAllowance,
  getPusdBalance,
  getUsdceAllowance,
  getUsdceBalance,
  isCtfApprovedForAll,
} from '@/lib/polymarket/allowance';
import {
  COLLATERAL_ONRAMP,
  CONDITIONAL_TOKENS,
  PUSD_ADDRESS,
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
  // V2 Exchange contract is the spender. Falls back to the regular V2 CTF
  // Exchange if the recommendation can't be resolved.
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

  const exchange = exchangeForMarket(negRisk) as `0x${string}`;
  const onramp = COLLATERAL_ONRAMP as `0x${string}`;
  const owner = address as `0x${string}`;

  let pusdBalance: bigint;
  let pusdAllowance: bigint;
  let usdceBalance: bigint;
  let usdceAllowance: bigint;
  let ctfApproved: boolean;
  try {
    [pusdBalance, pusdAllowance, usdceBalance, usdceAllowance, ctfApproved] = await Promise.all([
      getPusdBalance(owner),
      getPusdAllowance(owner, exchange),
      getUsdceBalance(owner),
      getUsdceAllowance(owner, onramp),
      isCtfApprovedForAll(owner, exchange),
    ]);
  } catch (err) {
    // All fallback RPCs failed. Return 200 with `unknown: true` so the
    // client can decide whether to surface a soft warning vs hard error.
    if (err instanceof AllRpcsFailedError) {
      console.warn('[trade/allowance] all RPCs failed', err.attempts);
    } else {
      console.error('[trade/allowance] RPC read failed', err);
    }
    return Response.json({
      unknown: true,
      pusd: { spender: exchange, token: PUSD_ADDRESS },
      usdce: { onramp, token: USDC_E_ADDRESS },
      ctf: { spender: exchange, token: CONDITIONAL_TOKENS },
      exchange: { negRisk, address: exchange },
    });
  }

  return Response.json({
    pusd: {
      balance: pusdBalance.toString(),
      allowance: pusdAllowance.toString(),
      spender: exchange,
      token: PUSD_ADDRESS,
    },
    usdce: {
      balance: usdceBalance.toString(),
      allowance: usdceAllowance.toString(),
      onramp,
      token: USDC_E_ADDRESS,
    },
    ctf: {
      approved: ctfApproved,
      spender: exchange,
      token: CONDITIONAL_TOKENS,
    },
    exchange: { negRisk, address: exchange },
  });
}
