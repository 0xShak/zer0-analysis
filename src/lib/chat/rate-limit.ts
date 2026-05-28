import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';

export const ANON_DAILY_LIMIT = 5;
export const WALLET_DAILY_LIMIT = 20;

/**
 * The key the daily cap is counted against. It MUST NOT be derived from any
 * value the caller can freely mint — the `zer0_sid` cookie and User-Agent are
 * both attacker-chosen (and the server regenerates a random sid when the cookie
 * is absent), so keying on the session fingerprint let anyone reset their quota
 * by rotating the cookie. Instead: authenticated callers key on their
 * JWT-verified user id; anonymous callers key on client IP. (The Telegram path
 * passes its own `tg:<userId>` key built from the Telegram-authenticated id.)
 *
 * NOTE: the anonymous branch is only as trustworthy as the IP we observe. On
 * the Vercel/edge deployment the platform sets the forwarded-IP header and
 * strips inbound spoofs; behind a different proxy, confirm the IP header can't
 * be forged by the client.
 */
export function rateLimitIdentity(args: {
  userId: string | null;
  ip: string;
}): string {
  if (args.userId) return `user:${args.userId}`;
  const ipHash = createHash('sha256').update(args.ip).digest('hex').slice(0, 32);
  return `ip:${ipHash}`;
}

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
