// Read-only preview of what the x-broadcast cron WOULD post on its next tick —
// without posting anything. Run this before flipping X_POSTING_ENABLED=true so
// there are no surprise tweets from a backlog of recent recommendations.
//
//   npm run x-dry-run   (or: tsx --env-file=.env.local scripts/x-broadcast-dry-run.ts)
//
// Mirrors the selection logic in src/lib/inngest/functions/x-broadcast.ts.

import { createAdminClient } from '../src/lib/supabase/admin';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const perTick = parseInt(process.env.X_SIGNALS_PER_TICK ?? '3', 10);
const dailyCap = parseInt(process.env.X_DAILY_SIGNAL_CAP ?? '25', 10);
const digestHour = parseInt(process.env.X_DIGEST_UTC_HOUR ?? '22', 10);

async function main() {
  const s = createAdminClient();
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS).toISOString();

  console.log('── x-broadcast dry run ──────────────────────────────────────');
  console.log('UTC now            :', now.toISOString(), `(hour ${now.getUTCHours()})`);
  console.log('X_POSTING_ENABLED  :', process.env.X_POSTING_ENABLED ?? '(unset → no-op)');
  console.log('per-tick / daily   :', `${perTick} / ${dailyCap}`);
  console.log('');

  // ── Signals ──
  const { data: recs, error } = await s
    .from('trade_recommendations')
    .select('id, market_question, side, price, conviction, created_at')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) {
    console.error('trade_recommendations query failed:', error.message);
    process.exit(1);
  }
  const { data: postedSignals, count: postedToday } = await s
    .from('x_posts')
    .select('ref_id', { count: 'exact' })
    .eq('kind', 'signal')
    .gte('posted_at', cutoff);
  const done = new Set((postedSignals ?? []).map((r) => r.ref_id));
  const unposted = (recs ?? []).filter((r) => !done.has(r.id));
  const budget = Math.max(0, Math.min(perTick, dailyCap - (postedToday ?? 0)));

  console.log(`SIGNALS: ${recs?.length ?? 0} in last 24h, ${unposted.length} not yet on X`);
  console.log(`         already posted in window: ${postedToday ?? 0} (daily cap ${dailyCap})`);
  console.log(`         → next tick would post up to ${Math.min(budget, unposted.length)} of them:`);
  for (const r of unposted.slice(0, budget)) {
    console.log(
      `           • ${r.side} @ ${r.price?.toFixed?.(2)} conv ${r.conviction?.toFixed?.(2)} — ${(r.market_question ?? '').slice(0, 55)}`,
    );
  }
  if (unposted.length > budget) {
    console.log(`           (+${unposted.length - budget} more, across later ticks)`);
  }

  // ── Digest ──
  const day = now.toISOString().slice(0, 10);
  const { data: digestRow } = await s
    .from('x_posts')
    .select('ref_id')
    .eq('kind', 'digest')
    .eq('ref_id', day)
    .limit(1);
  const digestDone = (digestRow ?? []).length > 0;
  const digestWouldFire = now.getUTCHours() >= digestHour && !digestDone;
  console.log('');
  console.log(`DIGEST:  hour gate ${digestHour} UTC — `, digestWouldFire ? 'WOULD POST now' : digestDone ? `already posted for ${day}` : `waits until ${digestHour}:00 UTC`);

  console.log('─────────────────────────────────────────────────────────────');
  console.log('(dry run — nothing was posted)');
}

void main();
