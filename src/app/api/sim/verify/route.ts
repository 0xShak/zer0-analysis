import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPendingSim } from '@/lib/sims/db';
import { isSimPaymentEnabled, markSimPaidAndEnqueue } from '@/lib/sims/request';
import { quotedSimAmount, verifyZer0Payment } from '@/lib/web3/zer0-payment';

// POST /api/sim/verify — web payment confirmation. The browser sends the
// $ZER0 transfer on Base (WalletConnect), waits for it to confirm, then posts
// { pending_sim_id, tx_hash } here. We verify on-chain and, if good, mark the
// sim PAID + fire the run. The TG path doesn't use this route (it verifies
// inline in wc/pay.ts), but the verification logic is shared.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Body = z.object({
  pending_sim_id: z.string().uuid(),
  tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
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
  const { pending_sim_id, tx_hash } = parsed.data;
  const supabase = createAdminClient();

  const pending = await getPendingSim(supabase, pending_sim_id);
  if (!pending) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  if (pending.state !== 'AWAITING_PAYMENT') {
    // Already paid/running/etc — treat as success so a double-submit is a no-op.
    return Response.json({ ok: true, state: pending.state });
  }
  if (!pending.pay_to_address) {
    return Response.json({ error: 'missing_sink' }, { status: 500 });
  }

  const result = await verifyZer0Payment({
    txHash: tx_hash,
    expectedTo: pending.pay_to_address,
    expectedAmount: await quotedSimAmount(),
    // Client confirmed the tx before calling — keep the wait short so the route
    // stays under maxDuration.
    waitMs: 30_000,
  });
  if (!result.ok) {
    return Response.json(
      { ok: false, reason: result.reason },
      { status: 402 },
    );
  }

  await markSimPaidAndEnqueue(supabase, pending_sim_id, tx_hash);
  return Response.json({ ok: true, state: 'PAID' });
}
