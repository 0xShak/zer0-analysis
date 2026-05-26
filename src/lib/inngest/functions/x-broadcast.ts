import { cron } from 'inngest';
import { inngest } from '../client';
import { createAdminClient } from '../../supabase/admin';
import { postTweet } from '../../x/client';
import { composeSignalTweet, composeDigestTweet } from '../../x/compose';

// Pushes ZER0's brain output to its public X profile (@atzer0_BOT).
//
// Two streams, both selective because X's write quota is small (Free ~500
// posts/month) and a public profile shouldn't be flooded with "no edge,
// skipped" noise:
//   1. SIGNALS — every new trade_recommendation (conviction > 0.65) gets one
//      tweet. Rare and high-value; this is the public track record.
//   2. DIGEST — one recap per day after X_DIGEST_UTC_HOUR, so the profile
//      stays alive between signals.
//
// Decoupled from brain-tick on purpose: a failed/limited tweet must never
// affect market analysis. Idempotency comes from the x_posts table's
// unique(kind, ref_id) — we CLAIM a row before calling X, so a step retry or
// two overlapping ticks can't double-post.
//
// Runs every 15 min. The poll is two cheap indexed Supabase queries; signals
// are rare so most ticks post nothing.
export const xBroadcast = inngest.createFunction(
  { id: 'zer0-x-broadcast', name: 'ZER0 X broadcast', triggers: [cron('*/15 * * * *')] },
  async ({ step, logger }) => {
    if ((process.env.X_POSTING_ENABLED ?? 'false') !== 'true') {
      return { skipped: 'X_POSTING_ENABLED is not true' };
    }
    const supabase = createAdminClient();
    const WINDOW_MS = 24 * 60 * 60 * 1000;
    const perTick = parseInt(process.env.X_SIGNALS_PER_TICK ?? '3', 10);
    const dailyCap = parseInt(process.env.X_DAILY_SIGNAL_CAP ?? '25', 10);
    const digestHour = parseInt(process.env.X_DIGEST_UTC_HOUR ?? '22', 10);

    // ─── 1. Trade signals ──────────────────────────────────────────────────
    const signalResult = await step.run('post-signals', async () => {
      const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();

      // Daily safety cap — never exceed N signal tweets per rolling 24h,
      // regardless of how many recommendations the brain produced.
      const { count: postedToday } = await supabase
        .from('x_posts')
        .select('id', { count: 'exact', head: true })
        .eq('kind', 'signal')
        .gte('posted_at', cutoff);
      if ((postedToday ?? 0) >= dailyCap) {
        return { posted: 0, reason: 'daily cap reached' };
      }

      // Recent calls, oldest first so the feed reads chronologically.
      const { data: recs } = await supabase
        .from('trade_recommendations')
        .select('id, market_question, side, price, conviction, rationale, created_at')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(50);
      if (!recs || recs.length === 0) return { posted: 0, reason: 'no recent signals' };

      // Which of those have we already posted (or claimed)?
      const ids = recs.map((r) => r.id);
      const { data: already } = await supabase
        .from('x_posts')
        .select('ref_id')
        .eq('kind', 'signal')
        .in('ref_id', ids);
      const done = new Set((already ?? []).map((r) => r.ref_id));

      const budget = Math.min(perTick, dailyCap - (postedToday ?? 0));
      let posted = 0;
      for (const rec of recs) {
        if (posted >= budget) break;
        if (done.has(rec.id)) continue;

        // Claim first. The unique(kind, ref_id) index means only one tick can
        // insert this row; a conflicting insert (another tick beat us) just
        // skips. We post only after the claim succeeds.
        const claim = await supabase
          .from('x_posts')
          .insert({ kind: 'signal', ref_id: rec.id });
        if (claim.error) continue; // already claimed elsewhere

        const text = await composeSignalTweet({
          question: rec.market_question ?? 'this market',
          side: rec.side,
          price: rec.price,
          conviction: rec.conviction,
          rationale: rec.rationale,
        });
        const res = await postTweet(text);
        if (res.ok) {
          await supabase
            .from('x_posts')
            .update({ tweet_id: res.id, content: text })
            .match({ kind: 'signal', ref_id: rec.id });
          posted += 1;
        } else {
          // Release the claim so a later tick retries, then stop this tick —
          // a failure is usually a rate limit or auth issue that won't clear
          // by hammering the next recommendation.
          await supabase.from('x_posts').delete().match({ kind: 'signal', ref_id: rec.id });
          logger.warn(`x-broadcast: signal post failed (${res.status}): ${res.error}`);
          break;
        }
      }
      return { posted };
    });

    // ─── 2. Daily digest ───────────────────────────────────────────────────
    const digestResult = await step.run('post-digest', async () => {
      const now = new Date();
      if (now.getUTCHours() < digestHour) {
        return { posted: false, reason: 'before digest hour' };
      }
      // One digest per UTC day, keyed on the date.
      const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
      const claim = await supabase.from('x_posts').insert({ kind: 'digest', ref_id: day });
      if (claim.error) return { posted: false, reason: 'already posted today' };

      const cutoff = new Date(now.getTime() - WINDOW_MS).toISOString();
      const [{ data: scans }, { count: signalCount }] = await Promise.all([
        supabase
          .from('market_scans')
          .select('category')
          .gte('last_analyzed_at', cutoff),
        supabase
          .from('trade_recommendations')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', cutoff),
      ]);

      const scanned = scans?.length ?? 0;
      const tally = new Map<string, number>();
      for (const s of scans ?? []) {
        const c = s.category ?? 'other';
        tally.set(c, (tally.get(c) ?? 0) + 1);
      }
      let topCategory: string | null = null;
      let topN = 0;
      for (const [c, n] of tally) {
        if (n > topN) {
          topN = n;
          topCategory = c;
        }
      }

      const text = await composeDigestTweet({
        scanned,
        signals: signalCount ?? 0,
        topCategory,
      });
      const res = await postTweet(text);
      if (res.ok) {
        await supabase
          .from('x_posts')
          .update({ tweet_id: res.id, content: text })
          .match({ kind: 'digest', ref_id: day });
        return { posted: true, day };
      }
      await supabase.from('x_posts').delete().match({ kind: 'digest', ref_id: day });
      logger.warn(`x-broadcast: digest post failed (${res.status}): ${res.error}`);
      return { posted: false, reason: `post failed: ${res.status}` };
    });

    return { signals: signalResult, digest: digestResult };
  },
);
