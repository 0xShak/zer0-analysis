// pro-verify-payment — durable on-chain confirmation of a $ZER0 PRO unlock.
//
// EXECUTES ON VERCEL. Triggered by pro/payment.submitted the moment the browser
// submits payment — BEFORE trusting any wallet-returned hash. We scan Base for
// the payer's $ZER0 Transfer to the sink and grant the 30-day entitlement the
// moment it lands. This is the safety net behind the inline /api/pro/verify
// check: it survives a dropped browser response, an unverified-yet (not-mined)
// tx, RPC flakiness, and serverless restarts — the same hard-won robustness as
// sim-verify-payment.
//
// The grant is idempotent: markProOrderPaidAndGrant flips AWAITING_PAYMENT→PAID
// under a state predicate, so whichever path (inline route or this scan) wins
// the transition is the only one that inserts the entitlement.

import { NonRetriableError } from 'inngest';
import { inngest, proPaymentSubmitted } from '../client';
import { createAdminClient } from '../../supabase/admin';
import {
  getProOrder,
  listUsedProTxHashes,
  markProOrderPaidAndGrant,
} from '../../pro/db';
import { scanForSimPayment, verifyZer0Payment } from '../../web3/zer0-payment';

const POLL_INTERVAL = '5s';
// ~10 min: covers wallet-approval latency + Base mining + brief RPC retries.
const VERIFY_MAX_POLLS = 120;
// Keep the fast-path receipt wait under the step's Vercel budget (maxDuration
// 60s). A miss just falls through to the scan loop.
const FAST_PATH_WAIT_MS = 20_000;
// How far back to gather already-used pay tx hashes to exclude from the scan.
const USED_HASH_LOOKBACK_MS = 6 * 60 * 60_000; // 6h

export const proVerifyPayment = inngest.createFunction(
  {
    id: 'zer0-pro-verify-payment',
    name: 'ZER0 PRO verify payment',
    triggers: [proPaymentSubmitted],
    retries: 2,
    onFailure: async ({ event, step }) => {
      const { orderId } = event.data.event.data as { orderId: string };
      console.error('[pro-verify-payment] terminal failure', { orderId });
      await step.run('mark-verify-crashed', async () => {
        const supabase = createAdminClient();
        const order = await getProOrder(supabase, orderId);
        if (!order || order.state !== 'AWAITING_PAYMENT') return;
        await supabase
          .from('pro_orders')
          .update({ error: 'payment_verify_crashed', updated_at: new Date().toISOString() })
          .eq('id', orderId);
      });
    },
  },
  async ({ event, step }) => {
    const { orderId, expectedFrom, sink, amountBaseUnits, fromBlock, txHash } =
      event.data;
    const supabase = createAdminClient();
    const minAmount = BigInt(amountBaseUnits);
    const startBlock = BigInt(fromBlock);

    // 1. Guard — only act on an order still awaiting payment (idempotent re-entry).
    const state = await step.run('guard', async () => {
      const order = await getProOrder(supabase, orderId);
      if (!order) throw new NonRetriableError(`pro_order ${orderId} not found`);
      return order.state;
    });
    if (state !== 'AWAITING_PAYMENT') {
      return { ok: true, skipped: true, state };
    }

    // 2. Fast path — try the browser-returned hash once. Never fatal.
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
        const claim = await step.run('claim-fast', async () => {
          const order = await getProOrder(supabase, orderId);
          if (!order || order.state !== 'AWAITING_PAYMENT') return 'already_settled';
          return markProOrderPaidAndGrant(supabase, order, txHash);
        });
        if (claim === 'granted' || claim === 'already_settled') {
          return { ok: true, via: 'returned-hash', claim };
        }
        // tx_taken — fall through to the scan for the payer's next transfer.
      }
    }

    // 3. Scan loop — the real safety net. Watch Base for the payer's Transfer to
    //    the sink, independent of anything the browser did.
    for (let i = 0; i < VERIFY_MAX_POLLS; i++) {
      const foundTxHash = await step.run(`scan-${i}`, async () => {
        const used = await listUsedProTxHashes(
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
        const claim = await step.run(`claim-scan-${i}`, async () => {
          const order = await getProOrder(supabase, orderId);
          if (!order || order.state !== 'AWAITING_PAYMENT') return 'already_settled';
          return markProOrderPaidAndGrant(supabase, order, foundTxHash);
        });
        if (claim === 'granted') return { ok: true, via: 'scan', txHash: foundTxHash };
        if (claim === 'already_settled') return { ok: true, via: 'scan-already-settled' };
        // claim === 'tx_taken': that transfer funds another order — keep polling;
        // next iteration's exclude set includes it, so the scan advances.
      }
      if (i === VERIFY_MAX_POLLS - 1) break;
      await step.sleep(`scan-wait-${i}`, POLL_INTERVAL);
    }

    // 4. Exhaustion — no payment seen in the window. Mark it; the user is told
    //    on their next /api/pro/order poll.
    await step.run('not-detected', async () => {
      const order = await getProOrder(supabase, orderId);
      if (!order || order.state !== 'AWAITING_PAYMENT') return;
      await supabase
        .from('pro_orders')
        .update({ state: 'EXPIRED', error: 'payment_not_detected', updated_at: new Date().toISOString() })
        .eq('id', orderId);
    });
    return { ok: false, reason: 'payment_not_detected' };
  },
);
