// Display formatting for the track-record dashboard. Kept tiny and pure so
// both server components and any future client widget can share it.

const DASH = '—';

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Signed dollars, e.g. +$12.34 / -$8.00 — for PnL where direction matters.
export function signedUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const sign = n < 0 ? '-' : '+';
  return `${sign}${usd(n)}`;
}

// 0..1 → "63%". `digits` controls precision (default 0).
export function pct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `${(n * 100).toFixed(digits)}%`;
}

// Tailwind text colour for a PnL value: emerald up, rose down, zinc flat.
export function pnlColor(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) {
    return 'text-zinc-300';
  }
  return n > 0 ? 'text-emerald-300' : 'text-rose-300';
}
