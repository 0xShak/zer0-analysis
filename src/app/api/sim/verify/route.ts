import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { getAddress, recoverMessageAddress, type Hex } from 'viem';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPendingSim } from '@/lib/sims/db';
import { isSimPaymentEnabled, markSimPaidAndEnqueue } from '@/lib/sims/request';
import { quotedSimAmount, verifyZer0Payment } from '@/lib/web3/zer0-payment';
import { simPaymentAuthMessage } from '@/lib/web3/sim-payment-auth';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { checkTradeRateLimit, rateLimitKey } from '@/lib/trades/rate-limit';

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
  // Payer proof: the connected wallet signs simPaymentAuthMessage(pending_sim_id)
  // and we require the on-chain transfer to originate from this same address —
  // so a public payment tx can't be claimed by anyone but the wallet that paid.
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
  const { pending_sim_id, tx_hash, from_address, signature } = parsed.data;
  const supabase = createAdminClient();

  // Shed floods before the expensive path (signature recovery + a 30s receipt
  // wait + log reads): unauthenticated callers could otherwise pin serverless
  // time and drain the RPC quota. A legit payer verifies once per sim.
  const ip = clientIpFromHeaders(req.headers);
  if (
    !(await checkTradeRateLimit(supabase, rateLimitKey([ip, 'sim-verify']), {
      limit: 10,
    }))
  ) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }

  // Recover the payer from the signature and require it to match the claimed
  // address. This is the wallet the on-chain transfer must originate from.
  let payer: string;
  try {
    const recovered = await recoverMessageAddress({
      message: simPaymentAuthMessage(pending_sim_id),
      signature: signature as Hex,
    });
    if (getAddress(recovered) !== getAddress(from_address)) {
      return Response.json({ ok: false, reason: 'bad_signature' }, { status: 401 });
    }
    payer = getAddress(from_address);
  } catch {
    return Response.json({ ok: false, reason: 'bad_signature' }, { status: 401 });
  }

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
    // Bind the transfer's sender to the wallet that proved control above — the
    // fix for the payment-hijack vector (web path previously omitted this).
    expectedFrom: payer,
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
