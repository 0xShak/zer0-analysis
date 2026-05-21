// GET /api/polymarket/builder-headers
//
// Exposes zer0's Polymarket builder credentials to the browser without
// bundling them into the client. The relayer + CLOB v2 SDKs need these to
// authenticate to https://relayer-v2.polymarket.com/submit and to attribute
// orders to our builder code. Keeping the route gives us:
//   - server-only env access (no NEXT_PUBLIC_ prefix on the secret)
//   - rotation without a rebuild
//   - a place to add origin / session checks later
//
// Note: the values are intentionally returned in plaintext to a same-origin
// browser context. The api-key surface area is therefore "anyone who can
// load the app's JS." Polymarket's relayer rate-limits per builder, so
// abuse mostly hurts our quota; we still rate-limit per IP here to slow
// any bulk scraping.

import type { NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { rateLimit, rateLimitKey } from '@/lib/trades/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ip = clientIpFromHeaders(req.headers);
  if (!rateLimit(rateLimitKey([ip, 'builder-headers']))) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }
  try {
    return Response.json({
      RELAYER_API_KEY: env.POLYMARKET_RELAYER_API_KEY,
      RELAYER_API_KEY_ADDRESS: env.POLYMARKET_RELAYER_API_KEY_ADDRESS,
      builderCode: env.POLYMARKET_BUILDER_CODE,
    });
  } catch (err) {
    // Missing env var. Surface a clear message; logs help diagnose at deploy.
    console.error('[builder-headers] env missing', err);
    return Response.json(
      { error: 'builder_credentials_unconfigured' },
      { status: 500 },
    );
  }
}
