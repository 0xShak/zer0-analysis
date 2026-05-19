import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { createCharge } from '@/lib/coinbase';

const Body = z.object({
  sessionId: z.string().uuid(),
  walletAddress: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const { sessionId, walletAddress } = parsed.data;

  const charge = await createCharge({ sessionId, walletAddress });

  const supabase = createAdminClient();
  await supabase.from('payments').insert({
    session_id: sessionId,
    coinbase_charge_id: charge.id,
    status: 'created',
    amount_usd: 5,
  });

  return Response.json({ hosted_url: charge.hosted_url, charge_id: charge.id });
}
