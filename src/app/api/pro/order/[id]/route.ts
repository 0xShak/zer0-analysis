import { type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsJson, preflight } from '@/lib/cors';
import { getProOrder } from '@/lib/pro/db';

// GET /api/pro/order/[id] — poll a PRO order's state. The landing page polls
// this after submitting payment so it can show "unlocked" once the durable
// verifier grants the entitlement (covers the case where the inline
// /api/pro/verify response was lost). CORS-enabled for the cross-origin site.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS(req: NextRequest) {
  return preflight(req.headers.get('origin'));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const origin = req.headers.get('origin');
  const { id } = await params;
  const supabase = createAdminClient();

  let order;
  try {
    order = await getProOrder(supabase, id);
  } catch (err) {
    console.error('[pro/order]', err);
    return corsJson(origin, { error: 'lookup_failed' }, { status: 500 });
  }
  if (!order) {
    return corsJson(origin, { error: 'not_found' }, { status: 404 });
  }

  let unlockedUntil: string | null = null;
  if (order.state === 'PAID' && order.entitlement_id) {
    const { data: ent } = await supabase
      .from('entitlements')
      .select('unlocked_until')
      .eq('id', order.entitlement_id)
      .maybeSingle();
    unlockedUntil = ent?.unlocked_until ?? null;
  }

  return corsJson(origin, {
    state: order.state,
    paid: order.state === 'PAID',
    unlocked_until: unlockedUntil,
    wallet_address: order.wallet_address,
  });
}
