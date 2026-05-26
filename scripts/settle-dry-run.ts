// Read-only sanity check for the settlement path. Loads open recommendations,
// fetches each market from Gamma, and prints what the settle job WOULD write —
// without mutating anything. Safe to run before the 0008 migration is applied.
//
//   npm run settle-dry-run        (or: tsx --env-file=.env.local scripts/settle-dry-run.ts)

import { createAdminClient } from '../src/lib/supabase/admin';
import { fetchMarketByCondition } from '../src/lib/polymarket/gamma';
import {
  interpretMarket,
  priceOfToken,
  scoreResolved,
  markToMarket,
  type Prediction,
} from '../src/lib/stats/scoring';

async function main() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('trade_recommendations')
    .select('id, market_condition_id, market_question, token_id, side, price, size')
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(25);
  if (error) {
    console.error('load failed:', error);
    process.exit(1);
  }
  const recs = data ?? [];
  console.log(`loaded ${recs.length} open recommendations\n`);

  let resolved = 0;
  let voided = 0;
  let marked = 0;
  let missing = 0;

  for (const rec of recs) {
    const market = await fetchMarketByCondition(rec.market_condition_id);
    const q = (rec.market_question ?? rec.market_condition_id).slice(0, 60);
    if (!market) {
      missing += 1;
      console.log(`✗ MISSING  ${q}`);
      continue;
    }
    const state = {
      closed: market.closed,
      clobTokenIds: market.clobTokenIds,
      outcomePrices: market.outcomePrices.map((p) => parseFloat(p)),
    };
    const pred: Prediction = {
      side: rec.side as 'BUY' | 'SELL',
      tokenId: rec.token_id,
      suggestedPrice: Number(rec.price),
      sizeUsd: Number(rec.size),
    };
    const interp = interpretMarket(state);

    if (interp.status === 'resolved') {
      const r = scoreResolved(pred, interp);
      if (r.outcome !== 'void') {
        resolved += 1;
        console.log(
          `● ${r.outcome.toUpperCase().padEnd(5)} ${q} | ${pred.side} | correct=${r.isCorrect} pnl=$${r.realizedPnlUsd.toFixed(2)}`,
        );
      }
    } else if (interp.status === 'void') {
      voided += 1;
      console.log(`◌ VOID    ${q} | prices=[${state.outcomePrices.join('/')}] closed=${state.closed}`);
    } else {
      const cur = priceOfToken(state, rec.token_id);
      if (cur === null) {
        missing += 1;
        console.log(`✗ NOTOKEN ${q}`);
        continue;
      }
      const mtm = markToMarket(pred, cur);
      marked += 1;
      console.log(
        `○ OPEN    ${q} | ${pred.side} @ ${pred.suggestedPrice} → mark ${cur.toFixed(3)} | ${mtm.inMoney ? 'IN$' : 'out'} pnl=$${mtm.markPnlUsd.toFixed(2)}`,
      );
    }
  }

  console.log(
    `\nsummary: resolved=${resolved} void=${voided} marked=${marked} missing=${missing} (DRY RUN — nothing written)`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
