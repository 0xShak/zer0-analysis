import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { createCharge } from '@/lib/coinbase';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { checkTradeRateLimit, rateLimitKey } from '@/lib/trades/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  sessionId: z.string().uuid(),
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'walletAddress must be a 0x… EVM address')
    .optional(),
});

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const { sessionId, walletAddress } = parsed.data;

  const supabase = createAdminClient();

  // Rate-limit BEFORE the external Coinbase call — this endpoint is
  // unauthenticated, so without a cap anyone could flood it to spam junk
  // charges into our Commerce dashboard and bloat the payments table.
  // failClosed: a DB hiccup must not uncap external charge creation (M-B).
  const ip = clientIpFromHeaders(req.headers);
  if (
    !(await checkTradeRateLimit(supabase, rateLimitKey([ip, 'checkout']), {
      limit: 5,
      failClosed: true,
    }))
  ) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }

  // Only create a charge for a session we actually issued — stops charges/
  // payments rows being created against arbitrary random UUIDs.
  const { data: session } = await supabase
    .from('sessions')
    .select('id')
    .eq('id', sessionId)
    .maybeSingle();
  if (!session) {
    return Response.json({ error: 'session_not_found' }, { status: 404 });
  }

  // Per-session cap, independent of IP (x-forwarded-for is only trustworthy
  // behind Vercel's edge): one session can't spawn unbounded pending charges.
  // Confirmed payments don't count, so a paying user is never blocked.
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { count: pending } = await supabase
    .from('payments')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('status', 'created')
    .gte('created_at', since);
  if ((pending ?? 0) >= 3) {
    return Response.json({ error: 'too_many_pending_charges' }, { status: 429 });
  }

  const charge = await createCharge({ sessionId, walletAddress });

  await supabase.from('payments').insert({
    session_id: sessionId,
    coinbase_charge_id: charge.id,
    status: 'created',
    amount_usd: 5,
  });

  return Response.json({ hosted_url: charge.hosted_url, charge_id: charge.id });
}
