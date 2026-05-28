// sim-verify-payment — durable on-chain confirmation of a $ZER0 pay-per-sim.
//
// EXECUTES ON VERCEL. Triggered by sim/payment.submitted the moment the bot
// asks the wallet to pay — BEFORE any wallet-returned tx hash. The bug this
// fixes: the bot used to trust the WalletConnect round-trip to hand back a hash,
// and a relay drop / timeout (after the transfer had already mined) lost the
// payment. Here we stop depending on that hash: we scan Base for the payer's
// Transfer to the sink and enqueue the run the moment it lands. Survives wallet
// timeouts, WC relay drops, bot restarts, and brief RPC flakiness.
//
// Shape mirrors sim-run.ts: a poll loop of step.run()/step.sleep() so the work
// survives Vercel's per-invocation timeout. The DB transition and the
// sim/requested send are SEPARATE steps on purpose — a dropped send retries on
// its own (the memoized transition won't re-run), so a payment is never lost
// after being recorded.

import { NonRetriableError } from 'inngest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { inngest, simPaymentSubmitted, simRequested } from '../client';
import { createAdminClient } from '../../supabase/admin';
import type { Database } from '../../database.types';
import {
  getPendingSim,
  listUsedPayTxHashes,
  markPendingSimPaidAtomic,
  updatePendingSim,
} from '../../sims/db';
import { scanForSimPayment, verifyZer0Payment } from '../../web3/zer0-payment';

type AdminClient = SupabaseClient<Database>;

const POLL_INTERVAL = '5s';
// ~10 min: covers wallet-approval latency (user may background the app) + Base
// mining + brief RPC retries, well past the §3a target window.
const VERIFY_MAX_POLLS = 120;
// Keep the fast-path receipt wait under the step's Vercel budget (maxDuration
// 60s). If the tx isn't mined yet, this returns receipt_not_found and we simply
// fall through to the scan loop — the hash was only ever an optimisation.
const FAST_PATH_WAIT_MS = 20_000;
// How far back to gather already-used pay_tx_hashes to exclude from the scan.
// The scan range is only minutes wide (fromBlock = when Pay was tapped), so any
// colliding tx is recent; this window just bounds the lookup with wide margin.
const USED_HASH_LOOKBACK_MS = 6 * 60 * 60_000; // 6h

const NOT_DETECTED_MESSAGE =
  "I didn't see your $ZER0 payment land on Base within the window. If you did pay, hang tight and ping me — otherwise tap /sim to try again.";

interface PaymentRouting {
  channel: 'web' | 'telegram';
  sessionId: string | null;
  userId: string | null;
  telegramChatId: number | null;
}

// Mirror sim-run's deliverSimMessage: Telegram → outbound_messages (the bot's
// listener forwards it), web → an assistant message in the session.
async function deliverPaymentMessage(
  supabase: AdminClient,
  routing: PaymentRouting,
  content: string,
): Promise<void> {
  if (routing.channel === 'telegram') {
    await supabase.from('outbound_messages').insert({
      channel: 'telegram',
      session_id: routing.sessionId,
      user_id: routing.userId,
      telegram_chat_id: routing.telegramChatId,
      content,
    });
  } else if (routing.sessionId) {
    await supabase.from('messages').insert({
      session_id: routing.sessionId,
      user_id: routing.userId,
      role: 'assistant',
      channel: 'web',
      content,
    });
  }
}

export const simVerifyPayment = inngest.createFunction(
  {
    id: 'zer0-sim-verify-payment',
    name: 'ZER0 sim verify payment',
    triggers: [simPaymentSubmitted],
    retries: 2,
    onFailure: async ({ event, step }) => {
      const { pendingSimId } = event.data.event.data as {
        pendingSimId: string;
      };
      console.error('[sim-verify-payment] terminal failure', { pendingSimId });
      await step.run('mark-verify-crashed', async () => {
        const supabase = createAdminClient();
        const pending = await getPendingSim(supabase, pendingSimId);
        // Leave a paid/running row alone — only flag a still-awaiting one.
        if (!pending || pending.state !== 'AWAITING_PAYMENT') return;
        await updatePendingSim(supabase, pendingSimId, {
          error: 'payment_verify_crashed',
        });
      });
    },
  },
  async ({ event, step }) => {
    const { pendingSimId, expectedFrom, sink, amountBaseUnits, fromBlock, txHash } =
      event.data;
    const supabase = createAdminClient();
    const minAmount = BigInt(amountBaseUnits);
    const startBlock = BigInt(fromBlock);

    // 1. Guard — only act on a row still awaiting payment (idempotent re-entry).
    const routing = await step.run('guard', async () => {
      const pending = await getPendingSim(supabase, pendingSimId);
      if (!pending) {
        throw new NonRetriableError(`pending_sim ${pendingSimId} not found`);
      }
      return {
        state: pending.state,
        channel: pending.channel,
        sessionId: pending.session_id,
        userId: pending.user_id,
        telegramChatId: pending.telegram_chat_id,
      };
    });
    if (routing.state !== 'AWAITING_PAYMENT') {
      return { ok: true, skipped: true, state: routing.state };
    }

    // 2. Fast path — if the wallet handed back a hash, try it once. Never fatal:
    //    a miss (not mined yet, dropped response) just falls into the scan loop.
    if (txHash) {
      const verified = await step.run('verify-returned-hash', async () => {
        const r = await verifyZer0Payment({
          txHash,
          expectedTo: sink,
          expectedFrom,
          expectedAmount: minAmount,
          waitMs: FAST_PATH_WAIT_MS,
        });
        return r.ok;
      });
      if (verified) {
        const claim = await step.run('claim-fast', () =>
          markPendingSimPaidAtomic(supabase, pendingSimId, txHash),
        );
        if (claim === 'claimed') {
          await step.run('enqueue-fast', () =>
            inngest.send(simRequested.create({ pendingSimId })),
          );
        }
        return { ok: true, via: 'returned-hash' };
      }
    }

    // 3. Scan loop — the real safety net. Watch Base for the payer's Transfer to
    //    the sink, independent of anything the wallet did. The scan step is pure
    //    (just getLogs); the transition + send are separate steps so a dropped
    //    send retries without re-doing or undoing the transition.
    for (let i = 0; i < VERIFY_MAX_POLLS; i++) {
      const foundTxHash = await step.run(`scan-${i}`, async () => {
        // Exclude tx hashes already funding another sim so a second concurrent
        // invoice from the same payer skips that transfer and finds its own.
        const used = await listUsedPayTxHashes(
          supabase,
          new Date(Date.now() - USED_HASH_LOOKBACK_MS).toISOString(),
        );
        const match = await scanForSimPayment({
          from: expectedFrom,
          to: sink,
          minAmount,
          fromBlock: startBlock,
          excludeTxHashes: used,
        });
        return match ? match.txHash : null;
      });
      if (foundTxHash) {
        const claim = await step.run(`claim-scan-${i}`, () =>
          markPendingSimPaidAtomic(supabase, pendingSimId, foundTxHash),
        );
        if (claim === 'claimed') {
          await step.run(`enqueue-scan-${i}`, () =>
            inngest.send(simRequested.create({ pendingSimId })),
          );
          return { ok: true, via: 'scan', txHash: foundTxHash };
        }
        if (claim === 'already_settled') {
          return { ok: true, via: 'scan-already-settled' };
        }
        // claim === 'tx_taken': that transfer was claimed by another sim between
        // our query and the write. Keep polling — next iteration's exclude set
        // includes it, so the scan advances to this payer's next transfer.
      }
      if (i === VERIFY_MAX_POLLS - 1) break;
      await step.sleep(`scan-wait-${i}`, POLL_INTERVAL);
    }

    // 4. Exhaustion — no payment seen in the window. Tell the user; don't hang.
    await step.run('not-detected', async () => {
      const pending = await getPendingSim(supabase, pendingSimId);
      if (!pending || pending.state !== 'AWAITING_PAYMENT') return;
      await updatePendingSim(supabase, pendingSimId, {
        state: 'EXPIRED',
        error: 'payment_not_detected',
      });
      await deliverPaymentMessage(supabase, routing, NOT_DETECTED_MESSAGE);
    });
    return { ok: false, reason: 'payment_not_detected' };
  },
);
