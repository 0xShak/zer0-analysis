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
 * 0012). Returns true when the call is allowed. Callers pass the service-role
 * client.
 *
 * Failure mode is per-caller. By default it fails OPEN: for /api/trade/* a
 * limiter hiccup must not block legitimate trading, and abuse there is bounded
 * by the per-day Supabase caps. Pass `failClosed: true` for routes where an
 * open limiter is itself the abuse — e.g. /api/checkout (external Coinbase
 * charge creation) and /api/polymarket/builder-sign (a signing oracle) — so a
 * DB hiccup denies rather than uncaps them (audit2.md M-B / L-A).
 */
export async function checkTradeRateLimit(
  supabase: SupabaseClient<Database>,
  key: string,
  opts: { limit?: number; windowSeconds?: number; failClosed?: boolean } = {},
): Promise<boolean> {
  const limit = opts.limit ?? LIMIT;
  const windowSeconds = opts.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const onError = !opts.failClosed; // fail open unless told otherwise
  const nowEpoch = Math.floor(Date.now() / 1000);
  try {
    const { data, error } = await supabase.rpc('incr_rate_limit_window', {
      k: key,
      window_seconds: windowSeconds,
      now_epoch: nowEpoch,
    });
    if (error) {
      console.error(`[trade-rate-limit] rpc failed, ${onError ? 'allowing' : 'denying'}`, error);
      return onError;
    }
    const count = typeof data === 'number' ? data : 0;
    return count <= limit;
  } catch (err) {
    console.error(`[trade-rate-limit] rpc threw, ${onError ? 'allowing' : 'denying'}`, err);
    return onError;
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
