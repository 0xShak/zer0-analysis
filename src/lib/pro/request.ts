// Shared "user wants to unlock PRO with $ZER0" logic — the quote half. Lives
// in one place so the (currently sole) /api/pro/quote caller and any future
// in-app entry use the same pegged-pricing + order-creation path.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { env } from '../env';
import { currentBaseBlock } from '../web3/zer0-payment';
import { quoteZer0ForUsd } from '../web3/zer0-price';
import { insertProOrder, type ProOrder } from './db';

type Db = SupabaseClient<Database>;

export function isProPaymentEnabled(): boolean {
  return env.ZER0_PRO_PAYMENT_ENABLED === 'true';
}

export interface ProQuote {
  orderId: string;
  /** Human $ZER0 amount, for display. */
  priceZer0: string;
  /** Exact transfer amount in base units (what the wallet must send). */
  amountBaseUnits: string;
  tokenAddress: string;
  sinkAddress: string;
  /** USD peg + the live price used, for transparency in the UI. */
  priceUsd: number;
  unitPriceUsd: number;
  expiresAt: string;
}

/**
 * Price a PRO unlock and open an AWAITING_PAYMENT order. The $ZER0 amount is
 * pegged to PRO_PRICE_USD at the live price and LOCKED on the order, so the
 * browser transfers exactly what we'll verify even if the price moves after.
 * from_block is the chain tip now — the durable scanner's lower bound.
 */
export async function createProQuote(
  supabase: Db,
  args: { walletAddress: string; sessionId?: string | null },
): Promise<ProQuote> {
  const targetUsd = Number(env.PRO_PRICE_USD);
  const [quote, fromBlock] = await Promise.all([
    quoteZer0ForUsd(targetUsd),
    currentBaseBlock(),
  ]);

  const order: ProOrder = await insertProOrder(supabase, {
    walletAddress: args.walletAddress,
    sessionId: args.sessionId ?? null,
    priceUsd: targetUsd,
    priceZer0: Number(quote.amountZer0),
    amountBaseUnits: quote.amountBaseUnits,
    tokenAddress: env.ZER0_TOKEN_ADDRESS,
    payToAddress: env.ZER0_PRO_SINK_ADDRESS,
    fromBlock,
  });

  return {
    orderId: order.id,
    priceZer0: quote.amountZer0,
    amountBaseUnits: quote.amountBaseUnits.toString(),
    tokenAddress: order.token_address,
    sinkAddress: order.pay_to_address,
    priceUsd: targetUsd,
    unitPriceUsd: quote.priceUsd,
    expiresAt: order.expires_at,
  };
}
