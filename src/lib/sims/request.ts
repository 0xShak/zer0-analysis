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
import { insertPendingSim, updatePendingSim, type PendingSim } from './db';

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

  const quote: SimQuote = {
    priceZer0: env.ZER0_SIM_PRICE,
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
 * Promote a paid (or payment-verified) pending_sim to PAID and fire the run.
 * Idempotent on pay_tx_hash via the unique index — a double-submit of the same
 * tx fails the insert/update path upstream, not here.
 */
export async function markSimPaidAndEnqueue(
  supabase: Db,
  pendingSimId: string,
  txHash: string,
): Promise<void> {
  await updatePendingSim(supabase, pendingSimId, {
    state: 'PAID',
    payTxHash: txHash,
    paidAt: new Date().toISOString(),
  });
  await inngest.send(simRequested.create({ pendingSimId }));
}
