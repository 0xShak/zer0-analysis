// Server-side POST /order from the Telegram bot.
//
// Why this exists (and isn't a thin SDK wrapper):
//   1. The V2 SDK's postOrder uses its own constructor-bound ClobClient
//      that signs with the relay key. We need to attach the *user's* L2
//      HMAC creds (derived per-EOA, cached), not the relay's.
//   2. The submit POST is geoblocked. If POLYMARKET_RELAY_URL is set we
//      forward through a relay container in a non-blocked region instead
//      of egressing directly.
//
// We construct the request manually so the HMAC body matches byte-for-byte
// what the bot sends — small body-stringification differences (sorted vs
// insertion-order keys, extra whitespace) silently break HMAC validation.

import { env } from '../../lib/env';
import { buildPolyHmacSignature } from './hmac';
import type { V2OrderForWire } from '../../lib/polymarket/clob';

const HOST = 'https://clob.polymarket.com';
const PATH = '/order';

export type OrderTypeWire = 'GTC' | 'GTD' | 'FOK' | 'FAK';

export interface ApiCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface PostOrderArgs {
  /** Signed wire-body order (signature field already attached). */
  order: V2OrderForWire & { signature: string };
  orderType: OrderTypeWire;
  /** Polymarket CLOB API key UUID (the L2 creds the bot caches per EOA). */
  creds: ApiCreds;
  /**
   * The address the L2 POLY_ADDRESS header must carry: the api-key's bound
   * owner (the connecting EOA). This is NOT necessarily order.signer — for a
   * sigType-3 deposit wallet, order.signer is the contract while the api-key
   * (and POLY_ADDRESS) belong to the EOA that owns it. The official SDK sends
   * getSignerAddress(signer) = the EOA here for every sig type. Falls back to
   * order.signer only when omitted (correct for sigType 1/2 where they match).
   */
  polyAddress?: string;
  /** Defer execution flag — almost always false for chat-driven trades. */
  deferExec?: boolean;
  fetchImpl?: typeof fetch;
}

export interface PostOrderResponse {
  success?: boolean;
  errorMsg?: string;
  orderID?: string;
  takingAmount?: string;
  makingAmount?: string;
  status?: string;
  transactionHash?: string;
  // ...other fields the SDK declares but we treat opaquely.
  [k: string]: unknown;
}

/**
 * Build the wire body shape Polymarket's CLOB V2 accepts (matches §A4 of
 * the spec). The HMAC must be computed over the *exact* JSON string we
 * POST, so we stringify here once and reuse.
 */
function buildWireBody(args: PostOrderArgs): string {
  // Must mirror @polymarket/clob-client-v2's `orderToJsonV2`
  // (node_modules/@polymarket/clob-client-v2/dist/types/ordersV2.js) EXACTLY —
  // the CLOB rejects anything else with a generic 400 "Invalid order payload".
  // Two things the previous hand-built body got wrong:
  //   1. `salt` must be a NUMBER (parseInt), not the string we sign/store.
  //   2. the body must include `postOnly`.
  const o = args.order;
  const body = {
    deferExec: args.deferExec ?? false,
    postOnly: false,
    order: {
      salt: parseInt(o.salt, 10),
      maker: o.maker,
      signer: o.signer,
      taker: o.taker,
      tokenId: o.tokenId,
      makerAmount: o.makerAmount,
      takerAmount: o.takerAmount,
      side: o.side,
      signatureType: o.signatureType,
      timestamp: o.timestamp,
      expiration: o.expiration,
      metadata: o.metadata,
      builder: o.builder,
      signature: o.signature,
    },
    owner: args.creds.apiKey,
    orderType: args.orderType,
  };
  return JSON.stringify(body);
}

/**
 * POST a signed Order to Polymarket. Honors POLYMARKET_RELAY_URL: when set,
 * the bot wraps {url, headers, body} in an envelope and posts to the relay,
 * which re-emits the actual request to clob.polymarket.com from a
 * non-blocked region. mTLS / shared-secret-HMAC is recommended for the
 * envelope on public hosts.
 */
export async function postOrder(args: PostOrderArgs): Promise<PostOrderResponse> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = buildWireBody(args);
  const timestampSec = Math.floor(Date.now() / 1000).toString();
  const polySig = await buildPolyHmacSignature(
    args.creds.secret,
    timestampSec,
    'POST',
    PATH,
    body,
  );

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    POLY_ADDRESS: args.polyAddress ?? args.order.signer,
    POLY_SIGNATURE: polySig,
    POLY_TIMESTAMP: timestampSec,
    POLY_API_KEY: args.creds.apiKey,
    POLY_PASSPHRASE: args.creds.passphrase,
  };

  if (env.POLYMARKET_RELAY_URL) {
    return postViaRelay({
      relayUrl: env.POLYMARKET_RELAY_URL,
      relaySecret: env.POLYMARKET_RELAY_SECRET,
      host: HOST,
      path: PATH,
      headers,
      body,
      fetchImpl,
    });
  }

  console.error('[post-order DEBUG] POST', `${HOST}${PATH}`);
  console.error('[post-order DEBUG] headers', {
    'Content-Type': headers['Content-Type'],
    POLY_ADDRESS: headers.POLY_ADDRESS,
    POLY_TIMESTAMP: headers.POLY_TIMESTAMP,
    POLY_API_KEY_len: headers.POLY_API_KEY?.length ?? 0,
    POLY_SIGNATURE_len: headers.POLY_SIGNATURE?.length ?? 0,
    POLY_PASSPHRASE_len: headers.POLY_PASSPHRASE?.length ?? 0,
  });
  console.error('[post-order DEBUG] body', body);
  const res = await fetchImpl(`${HOST}${PATH}`, {
    method: 'POST',
    headers,
    body,
  });
  const text = await res.text();
  console.error('[post-order DEBUG] response', res.status, text);
  if (!res.ok) {
    let parsed: PostOrderResponse | null = null;
    try {
      parsed = JSON.parse(text) as PostOrderResponse;
    } catch {
      /* response was not JSON */
    }
    throw new PostOrderError(res.status, text, parsed);
  }
  return JSON.parse(text) as PostOrderResponse;
}

interface RelayPostArgs {
  relayUrl: string;
  relaySecret: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  fetchImpl: typeof fetch;
}

async function postViaRelay(args: RelayPostArgs): Promise<PostOrderResponse> {
  const envelope = {
    host: args.host,
    path: args.path,
    method: 'POST',
    headers: args.headers,
    body: args.body,
  };
  const envelopeJson = JSON.stringify(envelope);
  const relayHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (args.relaySecret) {
    relayHeaders['X-Relay-Auth'] = await hmacRelayAuth(
      args.relaySecret,
      envelopeJson,
    );
  }
  const res = await args.fetchImpl(args.relayUrl, {
    method: 'POST',
    headers: relayHeaders,
    body: envelopeJson,
  });
  const text = await res.text();
  if (!res.ok) {
    let parsed: PostOrderResponse | null = null;
    try {
      parsed = JSON.parse(text) as PostOrderResponse;
    } catch {
      /* not JSON */
    }
    throw new PostOrderError(res.status, text, parsed);
  }
  return JSON.parse(text) as PostOrderResponse;
}

// Lightweight shared-secret HMAC for the relay envelope — guards against
// random internet traffic, not nation-states. Use mTLS for higher
// assurance.
async function hmacRelayAuth(secret: string, payload: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(secret);
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'hmacRelayAuth: globalThis.crypto.subtle unavailable; requires Node >= 20',
    );
  }
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  );
  return Buffer.from(sigBuf).toString('base64');
}

export class PostOrderError extends Error {
  readonly status: number;
  readonly raw: string;
  readonly body: PostOrderResponse | null;
  constructor(status: number, raw: string, body: PostOrderResponse | null) {
    super(`Polymarket CLOB rejected order (${status}): ${body?.errorMsg ?? raw}`);
    this.name = 'PostOrderError';
    this.status = status;
    this.raw = raw;
    this.body = body;
  }
}
