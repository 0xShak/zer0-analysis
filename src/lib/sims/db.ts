// pending_sims + simulations helpers — shared by the Telegram bot, the web
// API routes, and the sim-run Inngest function (which executes on Vercel). One
// thing per helper, throws-up-to-caller, mirroring db/pending-trades.ts.
//
// Lifecycle (state on pending_sims; status on simulations):
//
//   AWAITING_PAYMENT → PAID → RUNNING → COMPLETED
//                  ↘ EXPIRED (payment window elapsed)
//                  ↘ CANCELLED (user backed out)
//   RUNNING → FAILED (MiroShark / orchestration error)
//
// When the payment gate is off, pending_sims are created straight to PAID.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../database.types';

export type SimState = Database['public']['Enums']['sim_state'];
export type PendingSim = Database['public']['Tables']['pending_sims']['Row'];
export type Simulation = Database['public']['Tables']['simulations']['Row'];

type Db = SupabaseClient<Database>;

const DEFAULT_PAYMENT_WINDOW_MS = 15 * 60_000;

export interface InsertPendingSimArgs {
  channel: 'web' | 'telegram';
  scenario: string;
  userId?: string | null;
  sessionId?: string | null;
  telegramUserId?: number | null;
  telegramChatId?: number | null;
  state?: SimState;
  priceZer0?: number | null;
  payToAddress?: string | null;
  expiresInMs?: number;
}

export async function insertPendingSim(
  supabase: Db,
  args: InsertPendingSimArgs,
): Promise<PendingSim> {
  const expiresAt = new Date(
    Date.now() + (args.expiresInMs ?? DEFAULT_PAYMENT_WINDOW_MS),
  ).toISOString();
  const { data, error } = await supabase
    .from('pending_sims')
    .insert({
      channel: args.channel,
      scenario: args.scenario,
      user_id: args.userId ?? null,
      session_id: args.sessionId ?? null,
      telegram_user_id: args.telegramUserId ?? null,
      telegram_chat_id: args.telegramChatId ?? null,
      state: args.state ?? 'AWAITING_PAYMENT',
      price_zer0: args.priceZer0 ?? null,
      pay_to_address: args.payToAddress ?? null,
      expires_at: expiresAt,
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('pending_sim insert failed');
  return data;
}

export async function getPendingSim(
  supabase: Db,
  id: string,
): Promise<PendingSim | null> {
  const { data, error } = await supabase
    .from('pending_sims')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export interface UpdatePendingSimPatch {
  state?: SimState;
  payTxHash?: string | null;
  paidAt?: string | null;
  error?: string | null;
}

export async function updatePendingSim(
  supabase: Db,
  id: string,
  patch: UpdatePendingSimPatch,
): Promise<void> {
  type Update = Database['public']['Tables']['pending_sims']['Update'];
  const update: Update = { updated_at: new Date().toISOString() };
  if (patch.state !== undefined) update.state = patch.state;
  if (patch.payTxHash !== undefined) update.pay_tx_hash = patch.payTxHash;
  if (patch.paidAt !== undefined) update.paid_at = patch.paidAt;
  if (patch.error !== undefined) update.error = patch.error;
  const { error } = await supabase
    .from('pending_sims')
    .update(update)
    .eq('id', id);
  if (error) throw error;
}

/**
 * Expire AWAITING_PAYMENT rows whose window has elapsed. Returns the affected
 * ids so a caller (e.g. the bot's expiry cron) can notify them.
 */
export async function expireStalePendingSims(supabase: Db): Promise<string[]> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('pending_sims')
    .update({ state: 'EXPIRED', updated_at: nowIso })
    .lt('expires_at', nowIso)
    .eq('state', 'AWAITING_PAYMENT')
    .select('id');
  if (error) throw error;
  return (data ?? []).map((r) => r.id);
}

export interface CreateSimulationArgs {
  pendingSimId: string;
  channel: 'web' | 'telegram';
  scenario: string;
  userId?: string | null;
  sessionId?: string | null;
  telegramChatId?: number | null;
}

export async function createSimulationRow(
  supabase: Db,
  args: CreateSimulationArgs,
): Promise<Simulation> {
  const { data, error } = await supabase
    .from('simulations')
    .insert({
      pending_sim_id: args.pendingSimId,
      channel: args.channel,
      scenario: args.scenario,
      user_id: args.userId ?? null,
      session_id: args.sessionId ?? null,
      telegram_chat_id: args.telegramChatId ?? null,
      status: 'RUNNING',
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('simulation insert failed');
  return data;
}

export async function getSimulation(
  supabase: Db,
  id: string,
): Promise<Simulation | null> {
  const { data, error } = await supabase
    .from('simulations')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export interface UpdateSimulationPatch {
  status?: SimState;
  mirosharkProjectId?: string | null;
  mirosharkGraphId?: string | null;
  mirosharkSimulationId?: string | null;
  watchUrl?: string | null;
  shareCardUrl?: string | null;
  signalJson?: unknown;
  polymarketJson?: unknown;
  summary?: string | null;
  error?: string | null;
  wallClockMs?: number | null;
  completedAt?: string | null;
}

export async function updateSimulation(
  supabase: Db,
  id: string,
  patch: UpdateSimulationPatch,
): Promise<void> {
  type Update = Database['public']['Tables']['simulations']['Update'];
  const update: Update = {};
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.mirosharkProjectId !== undefined)
    update.miroshark_project_id = patch.mirosharkProjectId;
  if (patch.mirosharkGraphId !== undefined)
    update.miroshark_graph_id = patch.mirosharkGraphId;
  if (patch.mirosharkSimulationId !== undefined)
    update.miroshark_simulation_id = patch.mirosharkSimulationId;
  if (patch.watchUrl !== undefined) update.watch_url = patch.watchUrl;
  if (patch.shareCardUrl !== undefined) update.share_card_url = patch.shareCardUrl;
  if (patch.signalJson !== undefined)
    update.signal_json = patch.signalJson as Json;
  if (patch.polymarketJson !== undefined)
    update.polymarket_json = patch.polymarketJson as Json;
  if (patch.summary !== undefined) update.summary = patch.summary;
  if (patch.error !== undefined) update.error = patch.error;
  if (patch.wallClockMs !== undefined) update.wall_clock_ms = patch.wallClockMs;
  if (patch.completedAt !== undefined) update.completed_at = patch.completedAt;
  const { error } = await supabase
    .from('simulations')
    .update(update)
    .eq('id', id);
  if (error) throw error;
}
