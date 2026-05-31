import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsJson, preflight } from '@/lib/cors';
import { isProPaymentEnabled } from '@/lib/pro/request';
import { getProOrder, markProOrderPaidAndGrant } from '@/lib/pro/db';
import { inngest, proPaymentSubmitted } from '@/lib/inngest/client';
import { verifyZer0Payment } from '@/lib/web3/zer0-payment';

// POST /api/pro/verify — the browser sent the $ZER0 transfer on Base and posts
// { order_id, tx_hash } here. We ALWAYS hand off to the durable
// pro-verify-payment Inngest function first (so a dropped response / not-yet-
// mined tx still unlocks once it lands), then attempt a fast inline verify for
// instant feedback. Either path grants the wallet-keyed entitlement exactly
// once (atomic state flip). CORS-enabled for the cross-origin landing site.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Body = z.object({
  order_id: z.string().uuid(),
  tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export function OPTIONS(req: NextRequest) {
  return preflight(req.headers.get('origin'));
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!isProPaymentEnabled()) {
    return corsJson(origin, { error: 'payment_disabled' }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return corsJson(
      origin,
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { order_id, tx_hash } = parsed.data;
  const supabase = createAdminClient();

  const order = await getProOrder(supabase, order_id);
  if (!order) {
    return corsJson(origin, { error: 'not_found' }, { status: 404 });
  }
  if (order.state !== 'AWAITING_PAYMENT') {
    // Already settled (or expired) — idempotent no-op.
    return corsJson(origin, { ok: order.state === 'PAID', state: order.state });
  }

  // Durable safety net first — fires the chain scan regardless of what happens
  // inline, so the entitlement is granted even if this request dies mid-verify.
  await inngest.send(
    proPaymentSubmitted.create({
      orderId: order.id,
      expectedFrom: order.wallet_address,
      sink: order.pay_to_address,
      amountBaseUnits: order.amount_base_units,
      fromBlock: order.from_block,
      txHash: tx_hash,
    }),
  );

  // Fast inline verify for instant feedback. A miss isn't an error — the
  // durable function will grant it once the tx mines.
  const result = await verifyZer0Payment({
    txHash: tx_hash,
    expectedTo: order.pay_to_address,
    expectedFrom: order.wallet_address,
    expectedAmount: BigInt(order.amount_base_units),
    waitMs: 30_000,
  });
  if (!result.ok) {
    return corsJson(origin, {
      ok: false,
      pending: true,
      reason: result.reason,
      message:
        "Payment sent — I'm watching Base and PRO unlocks the moment it lands. Open the app and connect this wallet.",
    });
  }

  const claim = await markProOrderPaidAndGrant(supabase, order, tx_hash);
  return corsJson(origin, {
    ok: true,
    state: 'PAID',
    granted: claim === 'granted',
  });
}
