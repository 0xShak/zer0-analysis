import { cron } from 'inngest';
import { inngest } from '../client';
import { refreshCatalog } from '../../polymarket/catalog-cache';

// Snapshots Polymarket's active catalog into market_catalog_cache every 10 min,
// so live-market search (chat grounding + the X mention-respond cron) can run
// in-memory off the unprotected /markets feed instead of the Cloudflare-blocked
// /public-search. See migration 0014 and lib/polymarket/catalog-cache.ts.
//
// Cheap and self-contained: walks /markets (≤50 pages of 100, ordered by
// volume) and writes one JSON blob. ~10-min-stale prices are fine for grounding.
export const catalogRefresh = inngest.createFunction(
  {
    id: 'zer0-catalog-refresh',
    name: 'ZER0 market catalog refresh',
    triggers: [cron('*/10 * * * *')],
  },
  async ({ step, logger }) => {
    const count = await step.run('refresh-catalog', async () => refreshCatalog());
    logger.info(`catalog refreshed: ${count} markets`);
    return { markets: count };
  },
);
