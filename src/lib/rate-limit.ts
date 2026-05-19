import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export const ANON_DAILY_LIMIT = 5;
export const WALLET_DAILY_LIMIT = 20;

export async function incrementAndCheck(
  supabase: SupabaseClient<Database>,
  fingerprint: string,
  limit: number = ANON_DAILY_LIMIT,
): Promise<{ allowed: boolean; count: number; limit: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc('increment_rate_limit', {
    fp: fingerprint,
    today,
  });
  if (error) throw error;
  const count = data?.count ?? 0;
  return { allowed: count <= limit, count, limit };
}

export async function hasActiveEntitlement(
  supabase: SupabaseClient<Database>,
  args: { sessionId?: string; userId?: string },
): Promise<boolean> {
  const now = new Date().toISOString();
  let q = supabase.from('entitlements').select('id').gt('unlocked_until', now).limit(1);
  if (args.userId) q = q.eq('user_id', args.userId);
  else if (args.sessionId) q = q.eq('session_id', args.sessionId);
  else return false;
  const { data } = await q;
  return !!data?.length;
}
