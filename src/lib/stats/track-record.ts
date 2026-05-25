// Aggregates ZER0's recommendation track record for the /app/stats dashboard.
//
// This is the bot's *paper* track record across every recommendation it has
// made — "if you'd followed every call at the suggested price and size". It is
// not per-wallet realized PnL. Settlement (settle-predictions.ts) writes the
// per-row outcome columns this reads; here we only aggregate.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { createAdminClient } from '../supabase/admin';

// Conviction buckets for the calibration view. ZER0 only inserts a
// recommendation when conviction > 0.65, and the analyzer rejects > 0.95, so
// the live range is (0.65, 0.95].
const BUCKETS: Array<{ label: string; lo: number; hi: number }> = [
  { label: '0.65–0.75', lo: 0.65, hi: 0.75 },
  { label: '0.75–0.85', lo: 0.75, hi: 0.85 },
  { label: '0.85–0.95', lo: 0.85, hi: 0.95 },
];

export interface CalibrationBucket {
  label: string;
  n: number;
  wins: number;
  winRate: number | null; // null when n === 0
  avgConviction: number | null;
}

export interface CategoryRow {
  category: string;
  n: number;
  wins: number;
  winRate: number | null;
  realizedPnlUsd: number;
}

export interface ResolvedRow {
  id: string;
  question: string | null;
  side: 'BUY' | 'SELL';
  conviction: number;
  status: string; // 'won' | 'lost'
  isCorrect: boolean | null;
  realizedPnlUsd: number;
  resolvedAt: string | null;
}

export interface OpenRow {
  id: string;
  question: string | null;
  side: 'BUY' | 'SELL';
  conviction: number;
  markPnlUsd: number | null;
  inMoney: boolean;
}

export interface TrackRecord {
  counts: { total: number; resolved: number; open: number; void: number };
  realized: {
    wins: number;
    losses: number;
    winRate: number | null;
    pnlUsd: number;
    stakedUsd: number;
    roi: number | null;
  };
  open: {
    count: number;
    unrealizedPnlUsd: number;
    inMoneyCount: number;
  };
  calibration: CalibrationBucket[];
  byCategory: CategoryRow[];
  cumulativePnl: Array<{ resolvedAt: string; cumulativePnlUsd: number }>;
  recentResolved: ResolvedRow[];
  openPositions: OpenRow[];
}

type RecRow = Database['public']['Tables']['trade_recommendations']['Row'];

export async function computeTrackRecord(
  client?: SupabaseClient<Database>,
): Promise<TrackRecord> {
  const supabase = client ?? createAdminClient();

  const [{ data: recsData }, { data: scansData }] = await Promise.all([
    supabase
      .from('trade_recommendations')
      .select(
        'id, market_condition_id, market_question, side, conviction, size, status, is_correct, realized_pnl_usd, mark_pnl_usd, resolved_at',
      )
      .order('created_at', { ascending: false })
      .limit(1000),
    supabase.from('market_scans').select('condition_id, category'),
  ]);

  const recs = (recsData ?? []) as RecRow[];
  const categoryByCondition = new Map<string, string>(
    (scansData ?? []).map((s) => [s.condition_id, s.category ?? 'other']),
  );

  const resolved = recs.filter((r) => r.status === 'won' || r.status === 'lost');
  const openRecs = recs.filter((r) => r.status === 'open');
  const voidRecs = recs.filter((r) => r.status === 'void');

  // ─── Realized ──────────────────────────────────────────────────────────
  const wins = resolved.filter((r) => r.status === 'won').length;
  const losses = resolved.filter((r) => r.status === 'lost').length;
  const decided = wins + losses;
  const pnlUsd = resolved.reduce((a, r) => a + Number(r.realized_pnl_usd ?? 0), 0);
  const stakedUsd = resolved.reduce((a, r) => a + Number(r.size ?? 0), 0);

  // ─── Open / mark-to-market ────────────────────────────────────────────
  const unrealizedPnlUsd = openRecs.reduce(
    (a, r) => a + Number(r.mark_pnl_usd ?? 0),
    0,
  );
  const inMoneyCount = openRecs.filter((r) => Number(r.mark_pnl_usd ?? 0) > 0).length;

  // ─── Calibration ──────────────────────────────────────────────────────
  const calibration: CalibrationBucket[] = BUCKETS.map((b) => {
    const inBucket = resolved.filter((r) => {
      const c = Number(r.conviction);
      // Top bucket is inclusive of its upper bound (0.95).
      return c >= b.lo && (b.hi >= 0.95 ? c <= b.hi : c < b.hi);
    });
    const bWins = inBucket.filter((r) => r.status === 'won').length;
    const n = inBucket.length;
    return {
      label: b.label,
      n,
      wins: bWins,
      winRate: n > 0 ? bWins / n : null,
      avgConviction:
        n > 0 ? inBucket.reduce((a, r) => a + Number(r.conviction), 0) / n : null,
    };
  });

  // ─── By category ──────────────────────────────────────────────────────
  const catMap = new Map<string, { n: number; wins: number; pnl: number }>();
  for (const r of resolved) {
    const cat = categoryByCondition.get(r.market_condition_id) ?? 'other';
    const agg = catMap.get(cat) ?? { n: 0, wins: 0, pnl: 0 };
    agg.n += 1;
    if (r.status === 'won') agg.wins += 1;
    agg.pnl += Number(r.realized_pnl_usd ?? 0);
    catMap.set(cat, agg);
  }
  const byCategory: CategoryRow[] = [...catMap.entries()]
    .map(([category, a]) => ({
      category,
      n: a.n,
      wins: a.wins,
      winRate: a.n > 0 ? a.wins / a.n : null,
      realizedPnlUsd: a.pnl,
    }))
    .sort((a, b) => b.n - a.n);

  // ─── Cumulative PnL timeseries (oldest → newest by resolution time) ─────
  const byResolvedAt = [...resolved]
    .filter((r) => r.resolved_at)
    .sort(
      (a, b) =>
        new Date(a.resolved_at as string).getTime() -
        new Date(b.resolved_at as string).getTime(),
    );
  let running = 0;
  const cumulativePnl = byResolvedAt.map((r) => {
    running += Number(r.realized_pnl_usd ?? 0);
    return { resolvedAt: r.resolved_at as string, cumulativePnlUsd: running };
  });

  // ─── Recent lists ─────────────────────────────────────────────────────
  const recentResolved: ResolvedRow[] = [...resolved]
    .sort(
      (a, b) =>
        new Date(b.resolved_at ?? 0).getTime() -
        new Date(a.resolved_at ?? 0).getTime(),
    )
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      question: r.market_question,
      side: r.side,
      conviction: Number(r.conviction),
      status: r.status,
      isCorrect: r.is_correct,
      realizedPnlUsd: Number(r.realized_pnl_usd ?? 0),
      resolvedAt: r.resolved_at,
    }));

  const openPositions: OpenRow[] = [...openRecs]
    .sort((a, b) => Number(b.mark_pnl_usd ?? 0) - Number(a.mark_pnl_usd ?? 0))
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      question: r.market_question,
      side: r.side,
      conviction: Number(r.conviction),
      markPnlUsd: r.mark_pnl_usd === null ? null : Number(r.mark_pnl_usd),
      inMoney: Number(r.mark_pnl_usd ?? 0) > 0,
    }));

  return {
    counts: {
      total: recs.length,
      resolved: resolved.length,
      open: openRecs.length,
      void: voidRecs.length,
    },
    realized: {
      wins,
      losses,
      winRate: decided > 0 ? wins / decided : null,
      pnlUsd,
      stakedUsd,
      roi: stakedUsd > 0 ? pnlUsd / stakedUsd : null,
    },
    open: {
      count: openRecs.length,
      unrealizedPnlUsd,
      inMoneyCount,
    },
    calibration,
    byCategory,
    cumulativePnl,
    recentResolved,
    openPositions,
  };
}
