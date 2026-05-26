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

  if (existing) {
    const { error: updErr } = await supabase
      .from('tg_clob_api_creds')
      .update({
        signer_address: row.signerAddress,
        api_key: row.creds.apiKey,
        api_secret: row.creds.secret,
        api_passphrase: row.creds.passphrase,
        updated_at: new Date().toISOString(),
      })
      .eq('telegram_user_id', row.telegramUserId);
    if (updErr) throw updErr;
    return;
  }

  const { error: insErr } = await supabase.from('tg_clob_api_creds').insert({
    telegram_user_id: row.telegramUserId,
    signer_address: row.signerAddress,
    api_key: row.creds.apiKey,
    api_secret: row.creds.secret,
    api_passphrase: row.creds.passphrase,
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
      apiKey: data.api_key,
      secret: data.api_secret,
      passphrase: data.api_passphrase,
    },
  };
}
