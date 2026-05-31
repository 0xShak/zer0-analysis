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
  args: { sessionId?: string; userId?: string; walletAddress?: string },
): Promise<boolean> {
  const now = new Date().toISOString();

  // Resolve the user behind a connected wallet, so a PRO unlock bought on the
  // (cross-origin) landing page — which keys the entitlement to the payer's
  // wallet → users.id — is recognized in the app the moment that wallet is
  // connected. This is the only durable link between a landing-page payment
  // and an app user, since they share no session cookie.
  let userId = args.userId;
  if (!userId && args.walletAddress) {
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('wallet_address', args.walletAddress.toLowerCase())
      .maybeSingle();
    userId = user?.id ?? undefined;
  }

  let q = supabase.from('entitlements').select('id').gt('unlocked_until', now).limit(1);
  if (userId) q = q.eq('user_id', userId);
  else if (args.sessionId) q = q.eq('session_id', args.sessionId);
  else return false;
  const { data } = await q;
  return !!data?.length;
}
