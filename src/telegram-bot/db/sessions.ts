// tg_wc_sessions helpers. Mirrors the db.ts house style: select-then-insert,
// one-thing-per-helper, throws-up-to-caller. The bot's command handlers
// translate errors into Telegram replies.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../lib/database.types';

export type WalletType = 'eoa' | 'proxy' | 'safe' | 'deposit_wallet';

export interface WcSession {
  telegramUserId: number;
  sessionTopic: string;
  eoaAddress: string;
  funderAddress: string;
  signatureType: 0 | 1 | 2 | 3;
  walletType: WalletType;
  expiresAt: string;
}

const DEFAULT_TTL_DAYS = 7;

export async function saveWcSession(
  supabase: SupabaseClient<Database>,
  session: Omit<WcSession, 'expiresAt'> & { expiresAt?: string },
): Promise<void> {
  const expiresAt =
    session.expiresAt ??
    new Date(Date.now() + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // Single row per telegram_user_id (it's the primary key). If a user
  // re-runs /connect we overwrite the prior session — that's the desired
  // behavior since the old topic becomes useless on the wallet side.
  const { data: existing, error: selErr } = await supabase
    .from('tg_wc_sessions')
    .select('telegram_user_id')
    .eq('telegram_user_id', session.telegramUserId)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    const { error: updErr } = await supabase
      .from('tg_wc_sessions')
      .update({
        session_topic: session.sessionTopic,
        eoa_address: session.eoaAddress,
        funder_address: session.funderAddress,
        signature_type: session.signatureType,
        wallet_type: session.walletType,
        expires_at: expiresAt,
        last_used_at: new Date().toISOString(),
      })
      .eq('telegram_user_id', session.telegramUserId);
    if (updErr) throw updErr;
    return;
  }

  const { error: insErr } = await supabase.from('tg_wc_sessions').insert({
    telegram_user_id: session.telegramUserId,
    session_topic: session.sessionTopic,
    eoa_address: session.eoaAddress,
    funder_address: session.funderAddress,
    signature_type: session.signatureType,
    wallet_type: session.walletType,
    expires_at: expiresAt,
  });
  if (insErr) throw insErr;
}

export async function getWcSession(
  supabase: SupabaseClient<Database>,
  telegramUserId: number,
): Promise<WcSession | null> {
  const { data, error } = await supabase
    .from('tg_wc_sessions')
    .select('*')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    telegramUserId: data.telegram_user_id,
    sessionTopic: data.session_topic,
    eoaAddress: data.eoa_address,
    funderAddress: data.funder_address,
    signatureType: data.signature_type as 0 | 1 | 2 | 3,
    walletType: data.wallet_type,
    expiresAt: data.expires_at,
  };
}

export async function deleteWcSessionByTopic(
  supabase: SupabaseClient<Database>,
  topic: string,
): Promise<void> {
  const { error } = await supabase
    .from('tg_wc_sessions')
    .delete()
    .eq('session_topic', topic);
  if (error) throw error;
}

export async function touchWcSession(
  supabase: SupabaseClient<Database>,
  telegramUserId: number,
): Promise<void> {
  const { error } = await supabase
    .from('tg_wc_sessions')
    .update({ last_used_at: new Date().toISOString() })
    .eq('telegram_user_id', telegramUserId);
  if (error) throw error;
}
