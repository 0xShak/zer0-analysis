// tg_clob_api_creds helpers — per-Telegram-user Polymarket CLOB L2 creds.
//
// These rows are SECRETS (the api-key/secret/passphrase let the holder submit
// orders that authenticate as the user's signer). Only ever touch them through
// the service-role client (createAdminClient); RLS denies every other role.
//
// Mirrors the sessions.ts house style: select-then-upsert, one helper per verb,
// throws up to the caller.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../lib/database.types';
import type { ApiCreds } from '../polymarket/post-order';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from '../../lib/crypto/secret-box';

// Encrypted at rest with AES-256-GCM (audit2.md L3). Read stays back-compatible
// with any pre-migration plaintext value so a rollout can't break live users
// mid-flight; the 0014 migration drops old plaintext rows to force a clean
// re-/connect, after which every stored value is an encrypted envelope.
function readSecret(value: string): string {
  return isEncryptedSecret(value) ? decryptSecret(value) : value;
}

export interface ClobApiCredsRow {
  telegramUserId: number;
  signerAddress: string;
  creds: ApiCreds;
}

export async function saveClobApiCreds(
  supabase: SupabaseClient<Database>,
  row: ClobApiCredsRow,
): Promise<void> {
  // One row per telegram_user_id. Re-running /connect (e.g. switching wallets)
  // overwrites the prior creds, which is correct — they're bound to the EOA
  // that just connected (signer_address holds the api-key's bound address).
  const { data: existing, error: selErr } = await supabase
    .from('tg_clob_api_creds')
    .select('telegram_user_id')
    .eq('telegram_user_id', row.telegramUserId)
    .maybeSingle();
  if (selErr) throw selErr;

  const encrypted = {
    api_key: encryptSecret(row.creds.apiKey),
    api_secret: encryptSecret(row.creds.secret),
    api_passphrase: encryptSecret(row.creds.passphrase),
  };

  if (existing) {
    const { error: updErr } = await supabase
      .from('tg_clob_api_creds')
      .update({
        signer_address: row.signerAddress,
        ...encrypted,
        updated_at: new Date().toISOString(),
      })
      .eq('telegram_user_id', row.telegramUserId);
    if (updErr) throw updErr;
    return;
  }

  const { error: insErr } = await supabase.from('tg_clob_api_creds').insert({
    telegram_user_id: row.telegramUserId,
    signer_address: row.signerAddress,
    ...encrypted,
  });
  if (insErr) throw insErr;
}

export async function getClobApiCreds(
  supabase: SupabaseClient<Database>,
  telegramUserId: number,
): Promise<ClobApiCredsRow | null> {
  const { data, error } = await supabase
    .from('tg_clob_api_creds')
    .select('*')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    telegramUserId: data.telegram_user_id,
    signerAddress: data.signer_address,
    creds: {
      apiKey: readSecret(data.api_key),
      secret: readSecret(data.api_secret),
      passphrase: readSecret(data.api_passphrase),
    },
  };
}
