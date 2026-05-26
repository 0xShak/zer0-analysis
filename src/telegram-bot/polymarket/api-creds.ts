// Polymarket L2 API credential lookup for order submission.
//
// Per-user creds are derived at /connect (one extra WalletConnect signature
// over Polymarket's ClobAuth message; see derive-api-creds.ts) and stored in
// tg_clob_api_creds, bound to the user's trading-wallet signer address. Each
// order then authenticates with the key whose bound address equals the order's
// `signer` — which is what the CLOB requires.
//
// getApiCredsForUser reads that per-user row first and falls back to the shared
// env relay creds only when no per-user row exists (e.g. a wallet connected
// before this feature shipped). The fallback is the OLD behavior and produces
// "the order signer address has to be the address of the api key" for arbitrary
// users — it exists only so legacy sessions degrade rather than hard-crash.
//
// Env fallback (shared relay creds):
//   POLYMARKET_API_KEY
//   POLYMARKET_API_SECRET     (base64url, as returned by createOrDeriveApiKey)
//   POLYMARKET_API_PASSPHRASE

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../lib/database.types';
import { getClobApiCreds } from '../db/clob-creds';
import type { ApiCreds } from './post-order';

export interface ResolvedApiCreds {
  creds: ApiCreds;
  /**
   * The address the api-key is bound to — what the L2 POLY_ADDRESS header must
   * carry. For per-user creds this is the connecting EOA; for the env fallback
   * it's the relay key's owner address.
   */
  polyAddress: string;
}

/**
 * Resolve the L2 creds to authenticate this user's order with, plus the address
 * those creds are bound to (POLY_ADDRESS). Prefers the per-user row; falls back
 * to the shared env relay creds if the user has none yet.
 */
export async function getApiCredsForUser(
  supabase: SupabaseClient<Database>,
  telegramUserId: number,
): Promise<ResolvedApiCreds> {
  const row = await getClobApiCreds(supabase, telegramUserId);
  if (row) return { creds: row.creds, polyAddress: row.signerAddress };
  return getEnvRelayCreds();
}

/** Shared relay creds from env — the legacy fallback. */
export function getEnvRelayCreds(): ResolvedApiCreds {
  const apiKey = process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_API_SECRET;
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE;
  const polyAddress = process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS;
  if (!apiKey || !secret || !passphrase || !polyAddress) {
    throw new Error(
      'getApiCredsForUser: no per-user CLOB creds and the POLYMARKET_API_{KEY,SECRET,PASSPHRASE}/' +
        'POLYMARKET_RELAYER_API_KEY_ADDRESS env fallback is not set. Re-run /connect to derive per-user creds.',
    );
  }
  return { creds: { apiKey, secret, passphrase }, polyAddress };
}
