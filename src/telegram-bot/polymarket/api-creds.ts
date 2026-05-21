// Per-EOA Polymarket L2 API credential cache.
//
// Polymarket's createOrDeriveApiKey signs a deterministic L1 message with
// the user's signer key. The bot can't do that from WalletConnect without
// asking the user to sign at each /connect — and we don't want to.
//
// MVP shape (this module): until /connect derives or fetches per-user L2
// creds, callers fall back to a single set of relay-derived credentials
// via the env vars below. This means trades are submitted under the
// *bot's* api-key (the bot is responsible for the order, even though the
// USER signed it on-chain). Polymarket allows this — the order's signer
// proves provenance independent of the api-key.
//
// Set in env:
//   POLYMARKET_API_KEY
//   POLYMARKET_API_SECRET     (base64url, as returned by createOrDeriveApiKey)
//   POLYMARKET_API_PASSPHRASE
//
// Long-term: derive per-EOA creds during /connect (one extra wallet sign)
// and cache them in a new tg_clob_api_keys table.

import type { ApiCreds } from './post-order';

let cached: { eoa: string; creds: ApiCreds } | null = null;

export async function getApiCredsForEoa(eoa: string): Promise<ApiCreds> {
  if (cached && cached.eoa === eoa.toLowerCase()) return cached.creds;
  const apiKey = process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_API_SECRET;
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) {
    throw new Error(
      'getApiCredsForEoa: POLYMARKET_API_{KEY,SECRET,PASSPHRASE} env vars are not set. ' +
        'Derive a set via the V2 SDK createOrDeriveApiKey() and persist them.',
    );
  }
  cached = { eoa: eoa.toLowerCase(), creds: { apiKey, secret, passphrase } };
  return cached.creds;
}
