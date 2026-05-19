// In-memory sliding-window limiter for /api/trade/*.
// Per-instance only — when we run multiple Next.js replicas, swap for Redis.

const WINDOW_MS = 60 * 1000;
const LIMIT = 30;

const buckets = new Map<string, number[]>();

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
