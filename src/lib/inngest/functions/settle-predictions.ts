import { cron } from 'inngest';
import { inngest } from '../client';
import { createAdminClient } from '../../supabase/admin';
import { fetchMarketByCondition } from '../../polymarket/gamma';
import {
  interpretMarket,
  priceOfToken,
  scoreResolved,
  markToMarket,
  type Prediction,
} from '../../stats/scoring';

// How many open recommendations to settle per run. Resolutions are slow and the
// cadence is every 6h, so a cap keeps each run inside Vercel's 60s/step budget
// while still catching up over a day. Bump via SETTLE_BATCH if a backlog forms.
const SETTLE_BATCH = parseInt(process.env.SETTLE_BATCH ?? '150', 10);
const CONCURRENCY = 8;

type OpenRec = {
  id: string;
  market_condition_id: string;
  token_id: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
};

// Settle ZER0's open predictions against live Polymarket resolution.
//   - resolved markets  → status won/lost (+ is_correct, realized_pnl_usd)
//   - ambiguous closes  → status void (excluded from accuracy)
//   - still-open markets → refresh mark_price / mark_pnl_usd (mark-to-market)
// No LLM calls — Gamma reads only, so no budget guard is needed.
export const settlePredictions = inngest.createFunction(
  {
    id: 'zer0-settle-predictions',
    name: 'ZER0 settle predictions',
    triggers: [cron('0 */6 * * *')],
  },
  async ({ step, logger }) => {
    const supabase = createAdminClient();

    const open = await step.run('load-open', async () => {
      const { data, error } = await supabase
        .from('trade_recommendations')
        .select('id, market_condition_id, token_id, side, price, size')
        .eq('status', 'open')
        .order('created_at', { ascending: true })
        .limit(SETTLE_BATCH);
      if (error) {
        console.error('[settle] load-open failed:', error);
        return [] as OpenRec[];
      }
      return (data ?? []) as OpenRec[];
    });

    logger.info(`settle: ${open.length} open recommendations to check`);
    if (open.length === 0) {
      return { checked: 0, resolved: 0, voided: 0, marked: 0, missing: 0 };
    }

    const tallies = await step.run('settle', async () => {
      let resolved = 0;
      let voided = 0;
      let marked = 0;
      let missing = 0;
      const nowIso = new Date().toISOString();

      async function settleOne(rec: OpenRec): Promise<void> {
        const market = await fetchMarketByCondition(rec.market_condition_id);
        if (!market) {
          missing += 1;
          return;
        }
        const state = {
          closed: market.closed,
          clobTokenIds: market.clobTokenIds,
          outcomePrices: market.outcomePrices.map((p) => parseFloat(p)),
        };
        const pred: Prediction = {
          side: rec.side,
          tokenId: rec.token_id,
          suggestedPrice: Number(rec.price),
          sizeUsd: Number(rec.size),
        };

        const interp = interpretMarket(state);

        if (interp.status === 'resolved') {
          const r = scoreResolved(pred, interp);
          if (r.outcome === 'void') {
            // Defensive: scoreResolved only voids non-resolved input.
            missing += 1;
            return;
          }
          const { error } = await supabase
            .from('trade_recommendations')
            .update({
              status: r.outcome, // 'won' | 'lost'
              is_correct: r.isCorrect,
              realized_pnl_usd: r.realizedPnlUsd,
              resolution_price: r.resolutionPrice,
              winning_token_id: interp.winningTokenId,
              resolved_at: nowIso,
              settled_at: nowIso,
            })
            .eq('id', rec.id);
          if (error) console.error('[settle] resolved update failed:', rec.id, error);
          else resolved += 1;
          return;
        }

        if (interp.status === 'void') {
          const { error } = await supabase
            .from('trade_recommendations')
            .update({ status: 'void', resolved_at: nowIso, settled_at: nowIso })
            .eq('id', rec.id);
          if (error) console.error('[settle] void update failed:', rec.id, error);
          else voided += 1;
          return;
        }

        // Still open — refresh mark-to-market on the rec's own token.
        const cur = priceOfToken(state, rec.token_id);
        if (cur === null) {
          missing += 1;
          return;
        }
        const mtm = markToMarket(pred, cur);
        const { error } = await supabase
          .from('trade_recommendations')
          .update({
            mark_price: mtm.markPrice,
            mark_pnl_usd: mtm.markPnlUsd,
            settled_at: nowIso,
          })
          .eq('id', rec.id);
        if (error) console.error('[settle] mark update failed:', rec.id, error);
        else marked += 1;
      }

      for (let i = 0; i < open.length; i += CONCURRENCY) {
        const batch = open.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(settleOne));
      }
      return { resolved, voided, marked, missing };
    });

    logger.info(
      `settle: resolved=${tallies.resolved} voided=${tallies.voided} ` +
        `marked=${tallies.marked} missing=${tallies.missing}`,
    );
    return { checked: open.length, ...tallies };
  },
);
