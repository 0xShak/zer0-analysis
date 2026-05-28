// POST /api/polymarket/builder-sign
//
// Polymarket's V2 relayer + CLOB writes require HMAC builder authentication
// on every request. The four headers (`POLY_BUILDER_API_KEY`,
// `POLY_BUILDER_TIMESTAMP`, `POLY_BUILDER_PASSPHRASE`, `POLY_BUILDER_SIGNATURE`)
// are generated from the secret using a per-request HMAC. The polymarket.com
// UI explicitly warns that the secret must never reach the browser, so the
// SDK's `BuilderConfig` REMOTE mode POSTs `{ method, path, body, timestamp }`
// here, we sign on the server, and return only the resulting four headers.
//
// The api-key and passphrase end up in the browser because the SDK has to
// attach them as headers; only the secret stays exclusively server-side.
// Polymarket's design treats the secret as the credential — leaking the
// api-key/passphrase alone doesn't let an attacker forge signatures.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { buildHmacSignature } from '@polymarket/builder-signing-sdk';
import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import { clientIpFromHeaders } from '@/lib/chat/fingerprint';
import { checkTradeRateLimit, rateLimitKey } from '@/lib/trades/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SignPayload {
  method?: string;
  path?: string;
  body?: string;
  timestamp?: number;
}

// This route signs (method, path, body) with ZER0's builder HMAC secret. Left
// open it's a signing oracle: anyone could mint builder-authenticated requests
// for arbitrary relayer endpoints (and abuse ZER0's gas-sponsored builder
// relationship). The relayer SDK only ever attaches builder auth to these two
// requests — every other endpoint it calls (/nonce, /relay-payload,
// /transaction, /deployed) goes out unauthenticated — so restrict to them.
const ALLOWED_REQUESTS = new Set(['POST /submit', 'GET /transactions']);
// Relayer submit payloads are a few KB; refuse to sign anything oversized.
const MAX_BODY_LENGTH = 20_000;

export async function POST(req: NextRequest) {
  const ip = clientIpFromHeaders(req.headers);
  const supabase = createAdminClient();
  // failClosed: this signs with ZER0's builder HMAC, so a DB hiccup must not
  // turn it into an unthrottled signing oracle / gas-sponsorship faucet (L-A).
  if (
    !(await checkTradeRateLimit(supabase, rateLimitKey([ip, 'builder-sign']), {
      failClosed: true,
    }))
  ) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let payload: SignPayload;
  try {
    payload = (await req.json()) as SignPayload;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { method, path, body, timestamp } = payload;
  if (typeof method !== 'string' || typeof path !== 'string') {
    return NextResponse.json(
      { error: 'method_and_path_required' },
      { status: 400 },
    );
  }

  // Allowlist on (method, path) — match the path sans query string.
  const pathOnly = path.split('?')[0];
  if (!ALLOWED_REQUESTS.has(`${method.toUpperCase()} ${pathOnly}`)) {
    return NextResponse.json({ error: 'request_not_allowed' }, { status: 403 });
  }
  if (typeof body === 'string' && body.length > MAX_BODY_LENGTH) {
    return NextResponse.json({ error: 'body_too_large' }, { status: 413 });
  }

  let apiKey: string;
  let secret: string;
  let passphrase: string;
  try {
    apiKey = env.POLYMARKET_BUILDER_API_KEY;
    secret = env.POLYMARKET_BUILDER_SECRET;
    passphrase = env.POLYMARKET_BUILDER_PASSPHRASE;
  } catch (err) {
    console.error('[builder-sign] env missing', err);
    return NextResponse.json(
      { error: 'builder_credentials_unconfigured' },
      { status: 500 },
    );
  }

  const sigTimestamp = typeof timestamp === 'number' ? timestamp : Date.now();
  const signature = buildHmacSignature(
    secret,
    sigTimestamp,
    method,
    path,
    body,
  );

  // Exact shape expected by @polymarket/builder-signing-sdk's REMOTE mode —
  // see `dist/config.js#generateBuilderHeaders` (it forwards this response
  // as-is to the relayer / CLOB SDK callers).
  return NextResponse.json({
    POLY_BUILDER_API_KEY: apiKey,
    POLY_BUILDER_TIMESTAMP: sigTimestamp.toString(),
    POLY_BUILDER_PASSPHRASE: passphrase,
    POLY_BUILDER_SIGNATURE: signature,
  });
}
