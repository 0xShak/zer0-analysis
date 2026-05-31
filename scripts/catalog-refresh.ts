// Manually refresh the market-catalog cache (same work the zer0-catalog-refresh
// cron does) and smoke-test the search. Useful to populate the cache instantly
// from a working IP without waiting for the cron, and to confirm a named market
// is actually findable.
//
//   npm run catalog-refresh
//
// Requires migration 0014 applied (the market_catalog_cache table).

import { refreshCatalog, searchCatalog } from '../src/lib/polymarket/catalog-cache';

const PROBES = [
  "what's your read on the Switzerland 10-million initiative market?",
  'will trump win the nobel peace prize',
  'bitcoin 200k',
];

async function main() {
  console.log('Refreshing catalog from /markets …');
  const count = await refreshCatalog();
  console.log(`✅ cached ${count} active markets\n`);

  for (const q of PROBES) {
    const hits = await searchCatalog(q, 3);
    console.log(`Q: ${q}`);
    if (hits.length === 0) console.log('   (no candidate markets)');
    for (const h of hits) {
      console.log(`   • "${h.question.slice(0, 80)}"  Yes=${h.outcomePrices[0]}`);
    }
    console.log('');
  }
}
void main();
