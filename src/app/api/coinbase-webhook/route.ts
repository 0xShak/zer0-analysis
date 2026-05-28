import type { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyWebhook } from '@/lib/coinbase';

// zer0.md §7 — read RAW body before any JSON parsing so the HMAC verifies.
// Coinbase Commerce retries on failure, so the unique charge_id makes the
// insert idempotent.
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get('x-cc-webhook-signature') ?? '';

  let event: ReturnType<typeof verifyWebhook>;
  try {
    event = verifyWebhook(rawBody, signature);
  } catch {
    return new Response('invalid signature', { status: 400 });
  }

  const supabase = createAdminClient();

  if (event.type === 'charge:confirmed') {
    const data = event.data as { id: string; metadata?: { sessionId?: string; walletAddress?: string } };
    const sessionId = data.metadata?.sessionId ?? null;
    const walletAddress = data.metadata?.walletAddress;

    // Idempotency: Coinbase retries this webhook. Flip the payment to confirmed
    // only if it isn't already, and grant the entitlement only when THIS
    // delivery won that transition — otherwise retries stacked duplicate
    // 30-day entitlement rows. The .neq guard + .select makes the flip atomic
    // under concurrent deliveries (only one sees rows returned).
    const { data: flipped, error: flipErr } = await supabase
      .from('payments')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('coinbase_charge_id', data.id)
      .neq('status', 'confirmed')
      .select('id');
    if (flipErr) {
      // Transient DB error — 500 so Coinbase retries.
      return new Response('db error', { status: 500 });
    }
    if (!flipped || flipped.length === 0) {
      // Already confirmed (a retry) or an unknown charge — idempotent no-op.
      return new Response('ok');
    }

    let userId: string | null = null;
    if (walletAddress) {
      const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('wallet_address', walletAddress.toLowerCase())
        .maybeSingle();
      userId = user?.id ?? null;
    }

    const { error: grantErr } = await supabase.from('entitlements').insert({
      user_id: userId,
      session_id: sessionId,
      unlocked_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      source: 'coinbase_commerce',
    });
    if (grantErr) {
      // Compensate: roll the payment back so Coinbase's retry re-processes and
      // re-grants — never leave a paid user without their entitlement.
      await supabase
        .from('payments')
        .update({ status: 'created', confirmed_at: null })
        .eq('coinbase_charge_id', data.id);
      return new Response('grant failed', { status: 500 });
    }
  }

  return new Response('ok');
}
