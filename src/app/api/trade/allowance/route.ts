// GET /api/trade/allowance?address=0x...&recommendationId=<uuid>
//
// Preflight read for the V2 deposit-wallet trade flow. Returns:
//   - depositWallet: { address, deployed }      — CREATE2-derived from EOA
//   - pusd: { balance, allowance, spender }     — balances OF THE WALLET
//                                                  (not the EOA) and the
//                                                  pUSD→V2Exchange approval
//   - usdce: { balance, allowance, onramp }     — EOA-side; needed to drive
//                                                  the USDC.e → pUSD wrap
//                                                  (`to` = deposit wallet)
//   - ctf: { approved, spender }                — CTF.setApprovalForAll
//                                                  by the deposit wallet
//                                                  (SELL only)
//   - exchange: { negRisk, address }            — V2 Exchange address per
//                                                  the recommendation's
//                                                  neg_risk flag

import type { NextRequest } from 'next/server';
import { utils as ethersUtils } from 'ethers';
import { createAdminClient } from '@/lib/supabase/admin';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { checkTradeRateLimit, rateLimitKey } from '@/lib/trades/rate-limit';
import {
  AllRpcsFailedError,
  getPusdAllowance,
  getPusdBalance,
  getUsdceAllowance,
  getUsdceBalance,
  isCtfApprovedForAll,
} from '@/lib/polymarket/allowance';
import {
  deriveDepositWalletAddress,
  isDepositWalletDeployed,
} from '@/lib/polymarket/deposit-wallet';
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

  const supabase = createAdminClient();
  const ip = clientIpFromHeaders(req.headers);
  if (!(await checkTradeRateLimit(supabase, rateLimitKey([address.toLowerCase(), ip, 'allowance'])))) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }

  // Optional: look up the recommendation's neg_risk flag so we know which
  // V2 Exchange is the relevant spender. Default = regular CTF Exchange V2
  // if the recommendation can't be resolved.
  let negRisk = false;
  const recId = req.nextUrl.searchParams.get('recommendationId');
  if (recId && UUID_RE.test(recId)) {
    const { data: rec } = await supabase
      .from('trade_recommendations')
      .select('neg_risk')
      .eq('id', recId)
      .maybeSingle();
    if (rec) negRisk = Boolean(rec.neg_risk);
  }

  const exchange = exchangeForMarket(negRisk) as `0x${string}`;
  const onramp = COLLATERAL_ONRAMP as `0x${string}`;
  const eoa = address as `0x${string}`;
  const depositWallet = deriveDepositWalletAddress(eoa);

  let deployed: boolean;
  let pusdBalance: bigint;
  let pusdAllowance: bigint;
  let usdceBalance: bigint;
  let usdceAllowance: bigint;
  let ctfApproved: boolean;
  try {
    [
      deployed,
      pusdBalance,
      pusdAllowance,
      usdceBalance,
      usdceAllowance,
      ctfApproved,
    ] = await Promise.all([
      isDepositWalletDeployed(eoa),
      getPusdBalance(depositWallet),
      getPusdAllowance(depositWallet, exchange),
      getUsdceBalance(eoa),
      getUsdceAllowance(eoa, onramp),
      isCtfApprovedForAll(depositWallet, exchange),
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
      depositWallet: { address: depositWallet, deployed: false },
      pusd: { spender: exchange, token: PUSD_ADDRESS },
      usdce: { onramp, token: USDC_E_ADDRESS },
      ctf: { spender: exchange, token: CONDITIONAL_TOKENS },
      exchange: { negRisk, address: exchange },
    });
  }

  return Response.json({
    depositWallet: {
      address: depositWallet,
      deployed,
    },
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
