import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { isAddress } from 'viem';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsJson, preflight } from '@/lib/cors';
import { createProQuote, isProPaymentEnabled } from '@/lib/pro/request';

// POST /api/pro/quote — price a PRO unlock in $ZER0 (pegged to PRO_PRICE_USD at
// the live price) and open an AWAITING_PAYMENT order for the given wallet. The
// browser then sends the exact $ZER0 transfer on Base and calls /api/pro/verify.
// CORS-enabled: the landing site (zer0-FE) calls this cross-origin.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Body = z.object({
  wallet_address: z.string().refine(isAddress, 'invalid wallet address'),
  session_id: z.string().uuid().optional(),
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

  try {
    const supabase = createAdminClient();
    const quote = await createProQuote(supabase, {
      walletAddress: parsed.data.wallet_address,
      sessionId: parsed.data.session_id ?? null,
    });
    return corsJson(origin, { ok: true, quote });
  } catch (err) {
    // A failed price fetch lands here — never quote a wrong amount, surface it.
    console.error('[pro/quote]', err);
    return corsJson(
      origin,
      { error: 'quote_failed', message: 'Could not price $ZER0 right now — try again shortly.' },
      { status: 503 },
    );
  }
}
