// tg_pending_trades helpers — restart-safe state machine for the
// /ask → confirm → sign → submit flow.
//
// State transitions (enforced by callers, not the DB):
//
//   INTENT_PARSED
//     → AWAITING_USER_CONFIRM (when the echo message is sent)
//        → CANCELLED  (user tapped Cancel)
//        → EXPIRED    (90s cron with no Confirm)
//        → AWAITING_WALLET_SIG (user tapped Confirm)
//           → CANCELLED  (sign rejected / timed out)
//           → SUBMITTED  (CLOB acknowledged the POST)
//              → DONE   (resolution polled; matched OR final-no-match)
//
// Each helper does exactly one thing — mirrors db.ts style.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../../lib/database.types';
import type { Intent } from '../intent/parse';

export type TradeState =
  | 'INTENT_PARSED'
  | 'AWAITING_USER_CONFIRM'
  | 'AWAITING_WALLET_SIG'
  | 'SUBMITTED'
  | 'DONE'
  | 'CANCELLED'
  | 'EXPIRED';

export interface PendingTrade {
  id: string;
  telegramUserId: number;
  chatId: number;
  messageId: number | null;
  state: TradeState;
  tradeId: string | null;
  intent: Intent;
  typedData: unknown | null;
  walletMeta: unknown | null;
  expiresAt: string;
}

export interface InsertPendingTradeArgs {
  telegramUserId: number;
  chatId: number;
  intent: Intent;
  state?: TradeState;
  expiresInMs?: number;
}

const DEFAULT_EXPIRY_MS = 90_000;

export async function insertPendingTrade(
  supabase: SupabaseClient<Database>,
  args: InsertPendingTradeArgs,
): Promise<PendingTrade> {
  const expiresAt = new Date(
    Date.now() + (args.expiresInMs ?? DEFAULT_EXPIRY_MS),
  ).toISOString();
  const { data, error } = await supabase
    .from('tg_pending_trades')
    .insert({
      telegram_user_id: args.telegramUserId,
      chat_id: args.chatId,
      state: args.state ?? 'INTENT_PARSED',
      intent_json: args.intent as unknown as Json,
      expires_at: expiresAt,
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('pending-trade insert failed');
  return rowToPendingTrade(data);
}

export async function getPendingTrade(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<PendingTrade | null> {
  const { data, error } = await supabase
    .from('tg_pending_trades')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return rowToPendingTrade(data);
}

export async function updatePendingTrade(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: {
    state?: TradeState;
    messageId?: number | null;
    typedData?: unknown;
    walletMeta?: unknown;
    tradeId?: string | null;
  },
): Promise<void> {
  type Update = Database['public']['Tables']['tg_pending_trades']['Update'];
  const update: Update = {
    updated_at: new Date().toISOString(),
  };
  if (patch.state !== undefined) update.state = patch.state;
  if (patch.messageId !== undefined) update.message_id = patch.messageId;
  if (patch.typedData !== undefined) update.typed_data = patch.typedData as Json;
  if (patch.walletMeta !== undefined) update.wallet_meta = patch.walletMeta as Json;
  if (patch.tradeId !== undefined) update.trade_id = patch.tradeId;
  const { error } = await supabase
    .from('tg_pending_trades')
    .update(update)
    .eq('id', id);
  if (error) throw error;
}

/**
 * Expire any AWAITING_USER_CONFIRM rows whose `expires_at` has passed.
 * Returns the IDs that were transitioned so the caller can notify them.
 * Designed to be called every 30 seconds from a single-process cron in
 * the bot (start in index.ts after bot.start()).
 */
export async function expireStalePendingTrades(
  supabase: SupabaseClient<Database>,
): Promise<string[]> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('tg_pending_trades')
    .update({ state: 'EXPIRED', updated_at: nowIso })
    .lt('expires_at', nowIso)
    .eq('state', 'AWAITING_USER_CONFIRM')
    .select('id');
  if (error) throw error;
  return (data ?? []).map((r) => r.id);
}

function rowToPendingTrade(row: {
  id: string;
  telegram_user_id: number;
  chat_id: number;
  message_id: number | null;
  state: TradeState;
  trade_id: string | null;
  intent_json: unknown;
  typed_data: unknown | null;
  wallet_meta: unknown | null;
  expires_at: string;
}): PendingTrade {
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    state: row.state,
    tradeId: row.trade_id,
    intent: row.intent_json as Intent,
    typedData: row.typed_data,
    walletMeta: row.wallet_meta,
    expiresAt: row.expires_at,
  };
}
