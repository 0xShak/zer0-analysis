// Shared entry point for "the user wants to run a sim", used by both the
// Telegram /sim handler and the web /api/sim route so the payment gate lives
// in exactly one place.
//
// Gate (mirrors X_POSTING_ENABLED's ship-before-credentials pattern):
//   ZER0_SIM_PAYMENT_ENABLED !== 'true'  → sims run free: insert a PAID
//       pending_sim and fire sim/requested immediately.
//   ZER0_SIM_PAYMENT_ENABLED === 'true'  → insert AWAITING_PAYMENT with a
//       quote; the caller collects the $ZER0 payment, then calls
//       markSimPaidAndEnqueue() once the tx is verified on Base.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { env } from '../env';
import { inngest, simRequested } from '../inngest/client';
import { quotedSimAmount } from '../web3/zer0-payment';
import {
  insertPendingSim,
  markPendingSimPaidAtomic,
  type PendingSim,
} from './db';

type Db = SupabaseClient<Database>;

export function isSimPaymentEnabled(): boolean {
  return env.ZER0_SIM_PAYMENT_ENABLED === 'true';
}

export interface SimRequestInput {
  channel: 'web' | 'telegram';
  scenario: string;
  userId?: string | null;
  sessionId?: string | null;
  telegramUserId?: number | null;
  telegramChatId?: number | null;
}

export interface SimQuote {
  priceZer0: string; // human token amount, e.g. "1000"
  amountBaseUnits: string; // exact transfer amount in base units (price × 10^decimals)
  tokenAddress: string;
  sinkAddress: string;
}

export interface SimRequestResult {
  pendingSim: PendingSim;
  needsPayment: boolean;
  quote?: SimQuote;
}

export async function createSimRequest(
  supabase: Db,
  input: SimRequestInput,
): Promise<SimRequestResult> {
  if (!isSimPaymentEnabled()) {
    const pendingSim = await insertPendingSim(supabase, {
      ...input,
      state: 'PAID',
    });
    await inngest.send(simRequested.create({ pendingSimId: pendingSim.id }));
    return { pendingSim, needsPayment: false };
  }

  // quotedSimAmount() reads the token's on-chain decimals (cached) so the
  // amount the browser transfers matches verifyZer0Payment() exactly.
  const amountBaseUnits = await quotedSimAmount();
  const quote: SimQuote = {
    priceZer0: env.ZER0_SIM_PRICE,
    amountBaseUnits: amountBaseUnits.toString(),
    tokenAddress: env.ZER0_TOKEN_ADDRESS,
    sinkAddress: env.ZER0_SIM_SINK_ADDRESS,
  };
  const pendingSim = await insertPendingSim(supabase, {
    ...input,
    state: 'AWAITING_PAYMENT',
    priceZer0: Number(quote.priceZer0),
    payToAddress: quote.sinkAddress,
  });
  return { pendingSim, needsPayment: true, quote };
}

/**
 * Promote a payment-verified pending_sim to PAID and fire the run, atomically:
 * the AWAITING_PAYMENT → PAID flip and the sim/requested send only happen when
 * THIS call wins the transition, so a re-submit (or a concurrent claim) can't
 * double-run the sim. Returns whether the run was enqueued by this call.
 *
 * NOTE: the DB flip and the send are coupled here for the single-shot web path.
 * The durable Telegram verifier (sim-verify-payment) deliberately splits them
 * into separate Inngest steps so a dropped send retries on its own — see that
 * function rather than reusing this helper from inside a durable function.
 */
export async function markSimPaidAndEnqueue(
  supabase: Db,
  pendingSimId: string,
  txHash: string,
): Promise<boolean> {
  const transitioned = await markPendingSimPaidAtomic(
    supabase,
    pendingSimId,
    txHash,
  );
  if (transitioned) {
    await inngest.send(simRequested.create({ pendingSimId }));
  }
  return transitioned;
}
