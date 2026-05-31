import { cron } from 'inngest';
import { inngest } from '../client';
import { createAdminClient } from '../../supabase/admin';
import { getMentions, postTweet } from '../../x/client';
import { composeMentionTweet, composeOpinionTweet, stripMentionNoise } from '../../x/compose';
import { lookupLiveMarkets, type LiveMarketView } from '../../chat/market-lookup';
import { env } from '../../env';
import { isUnderDailyBudget } from '../../cost/budget';
import { logUsage } from '../../cost/log';
import { runResearch, formatResearchForPrompt } from '../../research/client';
import { analyzeForReply } from '../../agents/reply-analyzer';

// Opinionated reply path: research the grounded market, estimate a probability
// vs the market price, and compose a fair/over/under take. Returns null on ANY
// failure (no price, research/analysis error, no verdict) so the caller falls
// back to the plain price-quote reply — this branch can never break the
// existing working path. Logs both the model and research spend.
async function tryOpinionReply(
  top: LiveMarketView,
  logger: { warn: (msg: string) => void },
): Promise<string | null> {
  try {
    if (typeof top.yesPrice !== 'number') return null; // need a YES price to assess
    const research = await runResearch(top.question);
    const researchContext = formatResearchForPrompt(research);
    const hoursToRes = top.endDate
      ? Math.max(0, (new Date(top.endDate).getTime() - Date.now()) / 3_600_000)
      : 0;
    const current_prices = [
      top.yesPrice,
      ...(typeof top.noPrice === 'number' ? [top.noPrice] : []),
    ];
    const res = await analyzeForReply({
      question: top.question,
      resolutionSource: top.resolutionSource ?? undefined,
      outcomes: ['Yes', 'No'],
      current_prices,
      liquidity_usd: top.liquidityUsd,
      volume_24h_usd: top.volumeUsd,
      end_date: top.endDate ?? '',
      hours_to_resolution: hoursToRes,
      researchContext,
    });
    void logUsage({
      provider: 'openai',
      model: res.model,
      tokens_in: res.tokens_in,
      tokens_out: res.tokens_out,
      cached_tokens: res.cached_tokens,
      cost_usd: res.cost_usd,
      step: 'x-mention-analysis',
    }).catch(() => {});
    if (!res.verdict) return null;
    return composeOpinionTweet({ question: top.question, verdict: res.verdict });
  } catch (err) {
    logger.warn(
      `x-mentions: opinion analysis failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// Replies to mentions of ZER0 on its public X profile (@atzer0_BOT), but only
// when the mention names a market ZER0 can answer from LIVE Polymarket data.
//
// The silence gate is the whole point: lookupLiveMarkets() returns [] for
// chatter that doesn't map to a real market, and on an empty result ZER0 stays
// quiet (status 'skipped_ungrounded') rather than guess. So replies are always
// grounded — a price/volume/resolution quote, never an opinion.
//
// Idempotency + dedupe come from x_mentions.mention_id (PK = the incoming
// tweet id): a row is claimed before we reply, so a step retry or overlapping
// tick can't reply twice. A single-row x_mention_cursor holds since_id so each
// tick only fetches mentions newer than the last fully-processed one.
//
// Structurally a sibling of x-broadcast: decoupled from brain-tick, every-15-
// min cron, cheap indexed Supabase reads, no-op unless its flag is 'true'.
// Poll cadence is env-tunable (read at function registration). Default every
// 3 min so replies feel timely. Faster = lower latency but more getMentions
// calls against X's rate limit — if you see getMentions 429s, raise it. A
// shorter interval does NOT increase reply volume: the hourly cap still bounds
// that; it only shortens time-to-reply. Changing it needs a deploy + Inngest
// Apps→Resync (the cron schedule is registered with Inngest).
export const xMentions = inngest.createFunction(
  {
    id: 'zer0-x-mentions',
    name: 'ZER0 X mention-respond',
    triggers: [cron(process.env.X_MENTIONS_CRON ?? '*/3 * * * *')],
  },
  async ({ step, logger }) => {
    if ((process.env.X_MENTIONS_ENABLED ?? 'false') !== 'true') {
      return { skipped: 'X_MENTIONS_ENABLED is not true' };
    }
    const userId = env.X_BOT_USER_ID;
    if (!userId) return { skipped: 'X_BOT_USER_ID is not set' };

    const supabase = createAdminClient();
    // Replies are the expensive, public action — cap how many ZER0 posts per
    // rolling hour so a mention burst can't turn into a reply storm.
    const hourlyCap = parseInt(process.env.X_MENTION_REPLY_CAP ?? '5', 10);
    // Mentions are mostly hype chatter; require 2+ topic-word overlap with a
    // market before replying so a single common word ("send", "good") can't
    // false-match an unrelated market. Tunable without a deploy.
    const minOverlap = parseInt(process.env.X_MENTION_MIN_OVERLAP ?? '2', 10);
    // Opinionated takes (research + probability estimate vs market). Off by
    // default; capped per tick because each take runs a reasoning-model call
    // that must fit the 60s step budget (≤1 keeps us well clear).
    const analysisOn = (process.env.X_MENTION_ANALYSIS_ENABLED ?? 'false') === 'true';
    const maxPerTick = parseInt(process.env.X_MENTION_ANALYSIS_MAX_PER_TICK ?? '1', 10);

    const result = await step.run('respond-mentions', async () => {
      // ── Cursor: only fetch mentions newer than last time ──────────────────
      const { data: cur } = await supabase
        .from('x_mention_cursor')
        .select('since_id')
        .eq('id', 1)
        .single();
      const sinceId: string | undefined = cur?.since_id ?? undefined;

      const fetched = await getMentions(userId, sinceId);
      if (!fetched.ok) {
        logger.warn(`x-mentions: getMentions failed (${fetched.status}): ${fetched.error}`);
        return { replied: 0, skipped: 0, reason: `fetch failed: ${fetched.status}` };
      }
      if (fetched.mentions.length === 0) {
        return { replied: 0, skipped: 0, reason: 'no new mentions' };
      }

      // ── Hourly reply budget ───────────────────────────────────────────────
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: repliedLastHour } = await supabase
        .from('x_mentions')
        .select('mention_id', { count: 'exact', head: true })
        .eq('status', 'replied')
        .gte('created_at', hourAgo);
      let budget = Math.max(0, hourlyCap - (repliedLastHour ?? 0));

      // Opinionated-analysis daily $ guard — checked ONCE per tick (shared with
      // the brain's OpenAI budget). Over budget → still reply via price-quote,
      // never go silent on a grounded market.
      let analysisBudgetOk = false;
      if (analysisOn) {
        const b = await isUnderDailyBudget('openai');
        analysisBudgetOk = b.underBudget;
        if (!analysisBudgetOk) {
          logger.warn(
            `x-mentions: analysis over daily budget ($${b.spentUsd.toFixed(2)}/$${b.budgetUsd}); using price-quote replies`,
          );
        }
      }
      let analyzedThisTick = 0;

      // What have we already decided on? (one read instead of one-per-mention)
      const ids = fetched.mentions.map((m) => m.id);
      const { data: existingRows } = await supabase
        .from('x_mentions')
        .select('mention_id, status')
        .in('mention_id', ids);
      const statusById = new Map((existingRows ?? []).map((r) => [r.mention_id, r.status]));

      // Process oldest-first so the public thread reads chronologically. X
      // returns newest-first and tweet ids are time-ordered, so reversing gives
      // ascending ids — which lets us advance the cursor by simple assignment.
      const ordered = [...fetched.mentions].reverse();

      // cursorTo only moves past mentions we've FULLY resolved (replied /
      // skipped / already-terminal). It deliberately stops at a rate-capped or
      // failed mention so the next tick re-fetches and revisits it.
      let cursorTo: string | undefined = sinceId;
      let replied = 0;
      let skipped = 0;
      // Surfaces the exact stage/reason a tick stopped, in the function Output.
      let diag: string | undefined;

      for (const m of ordered) {
        const prior = statusById.get(m.id);

        // Already answered or already chose silence — terminal, safe to pass.
        if (prior === 'replied' || prior === 'skipped_ungrounded') {
          cursorTo = m.id;
          continue;
        }

        // Claim a row for a brand-new mention. A conflict means a concurrent
        // tick beat us to it; leave it for that tick (don't advance the cursor).
        if (prior === undefined) {
          const claim = await supabase.from('x_mentions').insert({
            mention_id: m.id,
            author: m.authorUsername ?? m.authorId,
            text: m.text,
            status: 'pending',
          });
          if (claim.error) continue;
        }
        // else prior is 'pending' or 'rate_capped' → re-process the existing row.

        // Out of hourly budget: record the intent and STOP advancing the cursor
        // so this mention (and any newer) is revisited next tick.
        if (budget <= 0) {
          await supabase
            .from('x_mentions')
            .update({ status: 'rate_capped' })
            .eq('mention_id', m.id);
          continue;
        }

        // The silence gate: no live market → ZER0 says nothing. Strip the
        // @handle chain / links first so grounding keys on real words.
        const clean = stripMentionNoise(m.text);
        let markets;
        try {
          markets = await lookupLiveMarkets(clean, { minOverlap, throwOnSearchError: true });
        } catch (err) {
          // Gamma errored (transient / rate / Cloudflare) — NOT a genuine
          // no-match. Leave the row 'pending' and stop without advancing the
          // cursor so this mention is retried next tick, instead of being
          // permanently silenced as 'skipped_ungrounded'.
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`x-mentions: gamma lookup failed for ${m.id}, will retry: ${msg}`);
          diag = `gamma_failed @${m.id}: ${msg.slice(0, 300)}`;
          break;
        }
        if (markets.length === 0) {
          await supabase
            .from('x_mentions')
            .update({ status: 'skipped_ungrounded' })
            .eq('mention_id', m.id);
          skipped += 1;
          cursorTo = m.id;
          continue;
        }

        // Opinionated take first (if enabled, under budget, and within the
        // per-tick cap); otherwise / on any failure, the plain price-quote
        // reply. Either way `text` is a grounded reply to this market.
        let text: string | null = null;
        if (analysisOn && analysisBudgetOk && analyzedThisTick < maxPerTick) {
          text = await tryOpinionReply(markets[0], logger);
          if (text) analyzedThisTick += 1;
        }
        text ??= await composeMentionTweet({ question: clean, markets });
        const res = await postTweet(text, m.id);
        if (res.ok) {
          await supabase
            .from('x_mentions')
            .update({ status: 'replied', reply_id: res.id })
            .eq('mention_id', m.id);
          replied += 1;
          budget -= 1;
          cursorTo = m.id;
        } else {
          // Leave the row 'pending' and stop without advancing the cursor — a
          // post failure is usually a transient rate/auth issue (see the 403/
          // 401 notes in x-test-tweet), so the next tick retries from here.
          logger.warn(`x-mentions: reply post failed (${res.status}): ${res.error}`);
          diag = `post_failed @${m.id}: ${res.status} ${String(res.error).slice(0, 200)}`;
          break;
        }
      }

      if (cursorTo && cursorTo !== sinceId) {
        await supabase
          .from('x_mention_cursor')
          .update({ since_id: cursorTo, updated_at: new Date().toISOString() })
          .eq('id', 1);
      }
      return { replied, skipped, fetched: ordered.length, ...(diag ? { diag } : {}) };
    });

    return result;
  },
);
