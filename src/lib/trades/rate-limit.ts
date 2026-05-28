// Rate limiting for /api/trade/* and builder-sign.
//
// TWO implementations live here:
//   - checkTradeRateLimit: Postgres-backed fixed-window counter, shared across
//     all serverless instances. Use this from the API routes — the old
//     in-memory Map did nothing across Vercel's many instances.
//   - rateLimit: the original in-memory sliding window. Kept ONLY for the
//     Telegram bot (a single always-on process, where per-instance state is
//     correct). Do not use it from serverless routes.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';

const WINDOW_MS = 60 * 1000;
const LIMIT = 30;

const buckets = new Map<string, number[]>();

const DEFAULT_WINDOW_SECONDS = 60;

/**
 * Shared fixed-window limiter backed by the rate_limit_buckets table (migration
 * 0012). Returns true when the call is allowed. Fails OPEN on a DB error: a
 * limiter hiccup must not block legitimate trading, and abuse is still bounded
 * by the per-day Supabase caps elsewhere. Callers pass the service-role client.
 */
export async function checkTradeRateLimit(
  supabase: SupabaseClient<Database>,
  key: string,
  opts: { limit?: number; windowSeconds?: number } = {},
): Promise<boolean> {
  const limit = opts.limit ?? LIMIT;
  const windowSeconds = opts.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const nowEpoch = Math.floor(Date.now() / 1000);
  try {
    const { data, error } = await supabase.rpc('incr_rate_limit_window', {
      k: key,
      window_seconds: windowSeconds,
      now_epoch: nowEpoch,
    });
    if (error) {
      console.error('[trade-rate-limit] rpc failed, allowing', error);
      return true;
    }
    const count = typeof data === 'number' ? data : 0;
    return count <= limit;
  } catch (err) {
    console.error('[trade-rate-limit] rpc threw, allowing', err);
    return true;
  }
}

export function rateLimit(key: string, limit = LIMIT, windowMs = WINDOW_MS): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const arr = buckets.get(key) ?? [];
  const recent = arr.filter((t) => t > cutoff);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

export function rateLimitKey(parts: Array<string | null | undefined>): string {
  return parts.map((p) => p ?? '-').join('|');
}
