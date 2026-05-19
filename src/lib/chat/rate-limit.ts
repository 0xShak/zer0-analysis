import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';

export const ANON_DAILY_LIMIT = 5;
export const WALLET_DAILY_LIMIT = 20;

export type RateCheck = {
  allowed: boolean;
  reason: 'daily_limit_reached' | null;
  count: number;
  limit: number;
};

// Atomic per-day counter via the increment_rate_limit SQL function defined in
// migration 0001. `userId` only affects the daily cap — both anonymous and
// authenticated sessions share the same fingerprint-keyed rate_limits row.
export async function checkRateLimit(
  supabase: SupabaseClient<Database>,
  fingerprint: string,
  userId: string | null,
): Promise<RateCheck> {
  const limit = userId ? WALLET_DAILY_LIMIT : ANON_DAILY_LIMIT;
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc('increment_rate_limit', {
    fp: fingerprint,
    today,
  });
  if (error) throw error;
  const count = data?.count ?? 0;
  const allowed = count <= limit;
  return {
    allowed,
    reason: allowed ? null : 'daily_limit_reached',
    count,
    limit,
  };
}
