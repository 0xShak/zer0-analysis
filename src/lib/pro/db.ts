// pro_orders helpers — the $ZER0 PRO unlock state machine + wallet-keyed
// entitlement grant. Used by the /api/pro/* routes and the durable
// pro-verify-payment Inngest function. One thing per helper, throws-up-to-
// caller, mirroring sims/db.ts.
//
// Lifecycle (state on pro_orders):
//   AWAITING_PAYMENT → PAID   (transfer verified on Base → entitlement granted)
//                  ↘ EXPIRED  (payment window elapsed with no valid tx)

import type { SupabaseClient } from '@supabase/supabase-js';
import { getAddress } from 'viem';
import type { Database } from '../database.types';
import { env } from '../env';

type Db = SupabaseClient<Database>;

export type ProOrder = Database['public']['Tables']['pro_orders']['Row'];

export interface InsertProOrderArgs {
  walletAddress: string;
  sessionId?: string | null;
  priceUsd: number;
  priceZer0: number;
  amountBaseUnits: bigint;
  tokenAddress: string;
  payToAddress: string;
  fromBlock: bigint;
  expiresInMs?: number;
}

const DEFAULT_PAYMENT_WINDOW_MS = 20 * 60_000;

export async function insertProOrder(
  supabase: Db,
  args: InsertProOrderArgs,
): Promise<ProOrder> {
  const expiresAt = new Date(
    Date.now() + (args.expiresInMs ?? DEFAULT_PAYMENT_WINDOW_MS),
  ).toISOString();
  const { data, error } = await supabase
    .from('pro_orders')
    .insert({
      wallet_address: args.walletAddress.toLowerCase(),
      session_id: args.sessionId ?? null,
      state: 'AWAITING_PAYMENT',
      price_usd: args.priceUsd,
      price_zer0: args.priceZer0,
      amount_base_units: args.amountBaseUnits.toString(),
      token_address: getAddress(args.tokenAddress),
      pay_to_address: getAddress(args.payToAddress),
      from_block: args.fromBlock.toString(),
      expires_at: expiresAt,
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('pro_order insert failed');
  return data;
}

export async function getProOrder(
  supabase: Db,
  id: string,
): Promise<ProOrder | null> {
  const { data, error } = await supabase
    .from('pro_orders')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Tx hashes already funding a PRO order, so the scanner skips a transfer that
 *  already settled another order (a wallet paying twice in the window). */
export async function listUsedProTxHashes(
  supabase: Db,
  sinceIso?: string,
): Promise<string[]> {
  let query = supabase
    .from('pro_orders')
    .select('pay_tx_hash')
    .not('pay_tx_hash', 'is', null);
  if (sinceIso) query = query.gte('updated_at', sinceIso);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? [])
    .map((r) => r.pay_tx_hash)
    .filter((h): h is string => typeof h === 'string');
}

export type ProPaidClaim = 'granted' | 'already_settled' | 'tx_taken';

/**
 * Settle an order: atomically flip AWAITING_PAYMENT → PAID recording the tx,
 * then grant the 30-day wallet-keyed entitlement. The `state` predicate makes
 * the flip a no-op for any later caller, so the inline /api/pro/verify path and
 * the durable scanner racing for the same payment can never grant twice. The
 * unique pay_tx_hash index is the second guard: one tx funds one order — a
 * collision surfaces as `tx_taken` so the scanner moves to the next transfer.
 *
 * Returns 'granted' only when THIS call won the transition (and thus inserted
 * the entitlement); 'already_settled' / 'tx_taken' otherwise.
 */
export async function markProOrderPaidAndGrant(
  supabase: Db,
  order: ProOrder,
  txHash: string,
): Promise<ProPaidClaim> {
  const nowIso = new Date().toISOString();

  // 1. Win the transition (idempotent across racing verifiers).
  const { data: claimed, error: claimErr } = await supabase
    .from('pro_orders')
    .update({ state: 'PAID', pay_tx_hash: txHash, paid_at: nowIso, updated_at: nowIso })
    .eq('id', order.id)
    .eq('state', 'AWAITING_PAYMENT')
    .select('id');
  if (claimErr) {
    // 23505 = unique_violation on pro_orders_pay_tx_idx: tx already funds
    // another order. Let the caller skip it and look further.
    if (claimErr.code === '23505') return 'tx_taken';
    throw claimErr;
  }
  if (!claimed?.length) return 'already_settled';

  // 2. Resolve (or create) the user row for this wallet, then grant.
  const userId = await upsertUserByWallet(supabase, order.wallet_address);
  const unlockedUntil = new Date(
    Date.now() + Number(env.PRO_ENTITLEMENT_DAYS) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: ent, error: entErr } = await supabase
    .from('entitlements')
    .insert({
      user_id: userId,
      session_id: order.session_id,
      unlocked_until: unlockedUntil,
      source: 'zer0_base_pro',
    })
    .select('id')
    .single();
  if (entErr || !ent) throw entErr ?? new Error('entitlement insert failed');

  await supabase
    .from('pro_orders')
    .update({ entitlement_id: ent.id, updated_at: new Date().toISOString() })
    .eq('id', order.id);

  return 'granted';
}

/** Find or create the users row for a wallet (lowercased), returning its id. */
export async function upsertUserByWallet(
  supabase: Db,
  walletAddress: string,
): Promise<string> {
  const wallet = walletAddress.toLowerCase();
  const { data: existing, error: selErr } = await supabase
    .from('users')
    .select('id')
    .eq('wallet_address', wallet)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing.id;

  const { data: inserted, error: insErr } = await supabase
    .from('users')
    .insert({ wallet_address: wallet })
    .select('id')
    .single();
  if (insErr || !inserted) throw insErr ?? new Error('user insert failed');
  return inserted.id;
}

/** Expire stale AWAITING_PAYMENT orders past their window. */
export async function expireStaleProOrders(supabase: Db): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('pro_orders')
    .update({ state: 'EXPIRED', updated_at: nowIso })
    .lt('expires_at', nowIso)
    .eq('state', 'AWAITING_PAYMENT')
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}
