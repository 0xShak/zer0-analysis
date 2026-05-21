// Force a trade_recommendations row for demo / testing.
//
// Usage:
//   npm run force-rec -- --side BUY --size 2
//   npm run force-rec -- --market <conditionId> --price 0.45
//   tsx --env-file=.env.local scripts/force-recommendation.ts --help
//
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY from the
// environment (load .env.local via `tsx --env-file=` — the `npm run
// force-rec` script does this for you). Defaults to picking the highest-
// liquidity active tradable market via Polymarket's Gamma API.

import { createAdminClient } from '../src/lib/supabase/admin';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

type Args = {
  side: 'BUY' | 'SELL';
  size: number;
  market?: string;
  token?: string;
  price?: number;
  rationale: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { side: 'BUY', size: 2, rationale: 'forced for demo' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--side') args.side = argv[++i] as 'BUY' | 'SELL';
    else if (arg === '--size') args.size = parseFloat(argv[++i]);
    else if (arg === '--market') args.market = argv[++i];
    else if (arg === '--token') args.token = argv[++i];
    else if (arg === '--price') args.price = parseFloat(argv[++i]);
    else if (arg === '--rationale') args.rationale = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: tsx --env-file=.env.local scripts/force-recommendation.ts [options]
   or: npm run force-rec -- [options]

Options:
  --side BUY|SELL          default BUY
  --size <usd>             default 2 (USD, 1-100)
  --market <conditionId>   optional; otherwise picks the highest-liquidity
                           tradable binary market
  --token <tokenId>        optional; defaults to first clobTokenId (YES)
  --price <p>              optional; defaults to live outcome price
  --rationale <text>       default 'forced for demo'
`);
      process.exit(0);
    }
  }
  if (args.side !== 'BUY' && args.side !== 'SELL') {
    throw new Error('--side must be BUY or SELL');
  }
  if (!Number.isFinite(args.size) || args.size < 1 || args.size > 100) {
    throw new Error('--size must be 1-100 USD');
  }
  return args;
}

function parseStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

type GammaMarket = {
  conditionId: string;
  question: string;
  clobTokenIds: string | string[];
  outcomePrices: string | string[];
  outcomes: string | string[];
  negRisk?: boolean;
  enableOrderBook?: boolean;
  closed?: boolean;
  archived?: boolean;
  active?: boolean;
};

async function fetchMarketByCondition(conditionId: string): Promise<GammaMarket> {
  const url = `${GAMMA_BASE}/markets?condition_ids=${conditionId}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gamma ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as GammaMarket[];
  if (!data?.length) throw new Error(`no market found for ${conditionId}`);
  return data[0];
}

async function fetchTopLiquidMarket(): Promise<GammaMarket> {
  const url = `${GAMMA_BASE}/markets?active=true&closed=false&archived=false&order=liquidityNum&ascending=false&limit=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gamma ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as GammaMarket[];
  for (const m of data ?? []) {
    const tokens = parseStringArray(m.clobTokenIds);
    if (m.enableOrderBook && tokens.length === 2 && !m.closed && !m.archived) {
      return m;
    }
  }
  throw new Error('no suitable market in top 20 liquid set');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const market = args.market
    ? await fetchMarketByCondition(args.market)
    : await fetchTopLiquidMarket();

  const tokens = parseStringArray(market.clobTokenIds);
  if (tokens.length === 0) throw new Error('market has no clobTokenIds');
  const tokenId = args.token ?? tokens[0];

  const prices = parseStringArray(market.outcomePrices);
  const tokenIndex = tokens.indexOf(tokenId);
  const fallbackPriceStr =
    tokenIndex >= 0 ? prices[tokenIndex] : prices[0] ?? '';
  const price =
    args.price ?? (fallbackPriceStr ? parseFloat(fallbackPriceStr) : 0.5);
  if (!Number.isFinite(price) || price <= 0.01 || price >= 0.99) {
    throw new Error(
      `price out of range (got ${price}). pass --price 0.05..0.95.`,
    );
  }

  const supabase = createAdminClient();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  const { data, error } = await supabase
    .from('trade_recommendations')
    .insert({
      market_condition_id: market.conditionId,
      market_question: market.question,
      token_id: tokenId,
      side: args.side,
      price,
      size: args.size,
      conviction: 0.7,
      rationale: args.rationale,
      neg_risk: Boolean(market.negRisk),
      status: 'open',
      expires_at: expiresAt,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('insert failed:', error);
    process.exit(1);
  }

  const tokens_str = tokens.map((t) => (t === tokenId ? `*${t}` : t)).join(', ');
  console.log('\n✓ forced recommendation created');
  console.log('  id:        ', data.id);
  console.log('  market:    ', market.question);
  console.log('  conditionId:', market.conditionId);
  console.log('  side:      ', args.side);
  console.log('  price:     ', price);
  console.log('  size:      ', `$${args.size}`);
  console.log('  token_id:  ', tokenId);
  console.log('  all tokens:', tokens_str);
  console.log('  neg_risk:  ', Boolean(market.negRisk));
  console.log('  expires:   ', expiresAt);
  console.log(
    '\nOpen the app — the new OPEN TRADE should appear within ~2s via realtime sub.\n',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
