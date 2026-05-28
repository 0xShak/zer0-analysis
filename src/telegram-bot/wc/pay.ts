// $ZER0 pay-per-sim over WalletConnect, on Base (eip155:8453).
//
// Sequenced last + gated (ZER0_SIM_PAYMENT_ENABLED) — see miroshark-zero.html
// §6 task 6 / §7. Flow: capture the Base chain tip → encode an ERC-20
// transfer(sink, price) → ask the user's connected wallet to
// eth_sendTransaction → ALWAYS hand off to the durable sim-verify-payment
// Inngest function, which scans Base for the transfer and runs the sim the
// moment it lands. We deliberately do NOT verify inline here: a dropped/
// timed-out WalletConnect response must no longer be able to lose a payment that
// actually mined (the bug). The wallet-returned hash, if any, is passed along as
// a fast-path optimisation only.
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
import { inngest, simPaymentSubmitted } from '../../lib/inngest/client';
import type { PendingSim } from '../../lib/sims/db';
import {
  ZER0_ERC20_ABI,
  currentBaseBlock,
  quotedSimAmount,
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

  // Capture the chain tip BEFORE asking the wallet to pay — this is the scan's
  // lower bound, so the durable verifier only inspects blocks from here forward.
  let fromBlock: bigint;
  try {
    fromBlock = await currentBaseBlock();
  } catch (err) {
    console.error('[telegram-bot] could not read Base block height', err);
    await edit(ctx, 'Base looks unreachable right now — try /sim again in a moment.');
    return;
  }

  // Ask the wallet to send. A timeout / relay drop is NO LONGER fatal: the
  // wallet may still broadcast the transfer, and the durable verifier scans
  // Base for it regardless. Capture the hash if it comes back (fast path), else
  // null — we never depend on it.
  let txHash: string | null = null;
  try {
    txHash = await sendBaseTransfer({
      topic: session.sessionTopic,
      from: session.eoaAddress,
      to: getAddress(env.ZER0_TOKEN_ADDRESS),
      data,
    });
  } catch (err) {
    console.warn(
      '[telegram-bot] wallet send returned no hash (timeout/drop) — handing off to chain scan',
      err,
    );
  }

  await inngest.send(
    simPaymentSubmitted.create({
      pendingSimId: pending.id,
      expectedFrom: session.eoaAddress,
      sink: pending.pay_to_address,
      amountBaseUnits: amount.toString(),
      fromBlock: fromBlock.toString(),
      txHash,
    }),
  );

  await edit(
    ctx,
    "Payment request sent — I'm watching Base and I'll run your sim the moment it lands, even if your wallet times out.",
  );
}
