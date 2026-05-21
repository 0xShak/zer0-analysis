// Cheap Gamma-API market search for free-form intent queries.
//
// We can't expose this as an LLM-callable tool (an injected prompt could
// flip the user's intent toward the wrong market). Instead we run a plain
// substring match over the active markets the brain-tick already polls,
// rank by liquidity, and present the top hit for confirmation alongside
// the trade echo. The user always sees the resolved market in the echo,
// so a wrong match is caught at the Confirm step.

import { fetchTradableMarkets, type GammaMarket } from '../../lib/polymarket/gamma';

export interface MarketSearchHit {
  market: GammaMarket;
  /** Heuristic score — higher = better match. */
  score: number;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export async function searchMarketByQuery(
  query: string,
  fetchMarkets: (limit?: number, offset?: number) => Promise<GammaMarket[]> = fetchTradableMarkets,
): Promise<MarketSearchHit | null> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return null;
  const pool = await fetchMarkets(200, 0);
  let best: MarketSearchHit | null = null;
  for (const market of pool) {
    const haystack = (market.question + ' ' + (market.description ?? '')).toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (haystack.includes(tok)) score += 1;
    }
    if (score === 0) continue;
    // Tie-break on liquidity (string number from Gamma).
    const liquidity = parseFloat(market.liquidity ?? '0') || 0;
    const ranked = score + Math.min(liquidity / 1_000_000, 0.5);
    if (!best || ranked > best.score) best = { market, score: ranked };
  }
  return best;
}
