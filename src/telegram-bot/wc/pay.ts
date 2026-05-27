// $ZER0 pay-per-sim over WalletConnect, on Base (eip155:8453).
//
// Sequenced last + gated (ZER0_SIM_PAYMENT_ENABLED) — see miroshark-zero.html
// §6 task 6 / §7. Flow: encode an ERC-20 transfer(sink, price) → ask the user's
// connected wallet to eth_sendTransaction on Base → verify the transfer landed
// on-chain → mark the pending_sim PAID and fire sim/requested.
//
// CAVEAT (§7): existing WC sessions are Polygon-scoped (wc/pair.ts pairs
// eip155:137). Base is now offered as an OPTIONAL namespace, so wallets paired
// after this change include it; older sessions will reject the Base request and
// the user is told to re-run /connect.

import type { Context } from 'grammy';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encodeFunctionData, getAddress, type Hex } from 'viem';
import type { Database } from '../../lib/database.types';
import { env } from '../../lib/env';
import { markSimPaidAndEnqueue } from '../../lib/sims/request';
import { updatePendingSim, type PendingSim } from '../../lib/sims/db';
import {
  ZER0_ERC20_ABI,
  quotedSimAmount,
  verifyZer0Payment,
} from '../../lib/web3/zer0-payment';
import { getWcSession } from '../db/sessions';
import { getSignClient } from './sign-client';

const BASE_CAIP2 = 'eip155:8453';
const SEND_TIMEOUT_MS = 120_000;

async function edit(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      link_preview_options: { is_disabled: true },
    });
  } catch {
    // Fall back to a fresh message if the original can't be edited.
    try {
      await ctx.reply(text, { link_preview_options: { is_disabled: true } });
    } catch {
      /* swallow */
    }
  }
}

// Send an ERC-20 transfer via WalletConnect on Base. Returns the tx hash.
async function sendBaseTransfer(args: {
  topic: string;
  from: string;
  to: string;
  data: Hex;
}): Promise<string> {
  const client = await getSignClient();
  const requestPromise = client.request<string>({
    topic: args.topic,
    chainId: BASE_CAIP2,
    request: {
      method: 'eth_sendTransaction',
      params: [{ from: args.from, to: args.to, data: args.data, value: '0x0' }],
    },
  });
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    handle = setTimeout(
      () => reject(new Error('wallet send request timed out')),
      SEND_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([requestPromise, timeout]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

export async function processSimPayment(
  ctx: Context,
  supabase: SupabaseClient<Database>,
  pending: PendingSim,
): Promise<void> {
  if (!pending.telegram_user_id || !pending.pay_to_address) {
    await edit(ctx, 'This sim request is missing payment details — start over with /sim.');
    return;
  }

  const session = await getWcSession(supabase, pending.telegram_user_id);
  if (!session) {
    await edit(ctx, "You'll need a connected wallet to pay. Send /connect first.");
    return;
  }

  const amount = await quotedSimAmount();
  const data = encodeFunctionData({
    abi: ZER0_ERC20_ABI,
    functionName: 'transfer',
    args: [getAddress(pending.pay_to_address), amount],
  });

  let txHash: string;
  try {
    txHash = await sendBaseTransfer({
      topic: session.sessionTopic,
      from: session.eoaAddress,
      to: getAddress(env.ZER0_TOKEN_ADDRESS),
      data,
    });
  } catch (err) {
    console.error('[telegram-bot] sim payment send failed', err);
    await updatePendingSim(supabase, pending.id, { error: 'payment_send_failed' });
    await edit(
      ctx,
      "Couldn't send the payment. If your wallet says Base isn't enabled for this session, re-run /connect and try again.",
    );
    return;
  }

  await edit(ctx, 'Payment sent — verifying on Base…');

  const result = await verifyZer0Payment({
    txHash,
    expectedTo: pending.pay_to_address,
    expectedAmount: amount,
    expectedFrom: session.eoaAddress,
  });
  if (!result.ok) {
    await updatePendingSim(supabase, pending.id, {
      error: `verify_${result.reason ?? 'unknown'}`,
      payTxHash: txHash,
    });
    await edit(
      ctx,
      `Payment didn't verify (${result.reason ?? 'unknown'}). If it went through, keep this tx hash: ${txHash}`,
    );
    return;
  }

  await markSimPaidAndEnqueue(supabase, pending.id, txHash);
  await edit(ctx, '✓ Paid. Running your sim now — I\'ll ping you the moment it lands.');
}
