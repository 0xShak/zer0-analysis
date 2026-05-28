import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPendingSim } from '@/lib/sims/db';
import { isSimPaymentEnabled } from '@/lib/sims/request';
import { currentBaseBlock, quotedSimAmount } from '@/lib/web3/zer0-payment';
import { recoverSimPayer } from '@/lib/web3/verify-sim-payer';
import { inngest, simPaymentSubmitted } from '@/lib/inngest/client';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { checkTradeRateLimit, rateLimitKey } from '@/lib/trades/rate-limit';

// POST /api/sim/pay-intent — register a web sim payment for DURABLE on-chain
// detection BEFORE the browser sends the transfer. Mirrors the Telegram path
// (wc/pay.ts): we capture the Base chain tip and fire sim/payment.submitted, so
// the sim-verify-payment Inngest function scans Base for the payer's transfer
// and runs the sim the moment it lands — even if the browser closes after
// paying. /api/sim/verify remains the fast path; this is the safety net so a
// paid user is never left without their sim.
//
// Bound to the payer's signature (same proof as /api/sim/verify) so this can't
// be used to point the scanner at someone else's public payment tx.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  pending_sim_id: z.string().uuid(),
  from_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

export async function POST(req: NextRequest) {
  if (!isSimPaymentEnabled()) {
    return Response.json({ error: 'payment_disabled' }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { pending_sim_id, from_address, signature } = parsed.data;
  const supabase = createAdminClient();

  const ip = clientIpFromHeaders(req.headers);
  if (
    !(await checkTradeRateLimit(supabase, rateLimitKey([ip, 'sim-pay-intent']), {
      limit: 10,
    }))
  ) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }

  const payer = await recoverSimPayer({
    pendingSimId: pending_sim_id,
    fromAddress: from_address,
    signature,
  });
  if (!payer) {
    return Response.json({ ok: false, reason: 'bad_signature' }, { status: 401 });
  }

  const pending = await getPendingSim(supabase, pending_sim_id);
  if (!pending) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  if (pending.state !== 'AWAITING_PAYMENT') {
    return Response.json({ ok: true, state: pending.state });
  }
  if (!pending.pay_to_address) {
    return Response.json({ error: 'missing_sink' }, { status: 500 });
  }

  // Capture the chain tip BEFORE the browser sends the transfer (the caller
  // awaits this response, then pays) so the scan's lower bound can't sit past
  // the payment's block.
  let fromBlock: bigint;
  try {
    fromBlock = await currentBaseBlock();
  } catch {
    return Response.json({ error: 'base_unreachable' }, { status: 503 });
  }
  const amount = await quotedSimAmount();

  await inngest.send(
    simPaymentSubmitted.create({
      pendingSimId: pending_sim_id,
      expectedFrom: payer,
      sink: pending.pay_to_address,
      amountBaseUnits: amount.toString(),
      fromBlock: fromBlock.toString(),
      txHash: null,
    }),
  );

  return Response.json({ ok: true, watching: true });
}
