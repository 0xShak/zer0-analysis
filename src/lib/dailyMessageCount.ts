// Client-side mirror of the per-day chat quota. The backend authoritatively
// rate-limits against rate_limits.fingerprint+day; this is just a local
// indicator so the sidebar shows accurate usage across reloads.

const KEY = 'zer0:dailyMessageCount';

type Stored = { date: string; count: number };

function todayKey(): string {
  // UTC date, matches Postgres `current_date` on Supabase (UTC by default).
  return new Date().toISOString().slice(0, 10);
}

export function readDailyCount(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Stored;
    if (parsed.date !== todayKey()) return 0;
    return Number.isFinite(parsed.count) ? Math.max(0, parsed.count) : 0;
  } catch {
    return 0;
  }
}

export function bumpDailyCount(): number {
  if (typeof window === 'undefined') return 0;
  const next = readDailyCount() + 1;
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ date: todayKey(), count: next }),
    );
  } catch {
    // localStorage may be unavailable (private mode, quota); UI just reverts
    // to in-memory counting.
  }
  return next;
}
