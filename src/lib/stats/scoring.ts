// Pure scoring logic for ZER0's prediction track record. No I/O here so the
// math is trivially unit-testable — the settlement job (settle-predictions.ts)
// supplies the live market data and persists the result.
//
// A recommendation is always on a 2-outcome market (passesNumericFilter
// enforces exactly two outcomes). It stores a `token_id` (one of the market's
// clobTokenIds) and a `side`:
//   BUY  → that token should resolve to 1 (win)  — correct iff it's the winner
//   SELL → that token should resolve to 0 (lose) — correct iff it's NOT winner
//
// PnL is hypothetical "paper" PnL: if you'd followed the call at the suggested
// price and size. Selling a token at price p is modelled as buying its
// complement at (1 - p), so both sides reduce to the same payout formula on an
// effective entry price.

// A binary market is treated as RESOLVED only when it's closed AND the prices
// have collapsed cleanly to ~1 / ~0. A closed market whose prices haven't
// collapsed (e.g. a 50/50 refund, or still mid-settlement) is VOID — excluded
// from accuracy rather than scored as a coin-flip.
const RESOLVED_HI = 0.99;
const RESOLVED_LO = 0.01;

export type Side = 'BUY' | 'SELL';

export interface MarketState {
  closed: boolean;
  // Index-aligned arrays straight off GammaMarket.
  clobTokenIds: string[];
  outcomePrices: number[];
}

export type MarketInterpretation =
  | { status: 'resolved'; winningTokenId: string; winningPrice: number }
  | { status: 'void' }
  | { status: 'open' };

// Decide whether a market has resolved, and if so which token won.
export function interpretMarket(m: MarketState): MarketInterpretation {
  if (!m.closed) return { status: 'open' };
  if (m.clobTokenIds.length !== 2 || m.outcomePrices.length !== 2) {
    return { status: 'void' };
  }
  const [p0, p1] = m.outcomePrices;
  if (!Number.isFinite(p0) || !Number.isFinite(p1)) return { status: 'void' };

  const hiIdx = p0 >= p1 ? 0 : 1;
  const loIdx = hiIdx === 0 ? 1 : 0;
  if (m.outcomePrices[hiIdx] >= RESOLVED_HI && m.outcomePrices[loIdx] <= RESOLVED_LO) {
    return {
      status: 'resolved',
      winningTokenId: m.clobTokenIds[hiIdx],
      winningPrice: m.outcomePrices[hiIdx],
    };
  }
  return { status: 'void' };
}

// Current price of a specific token within a market (for mark-to-market).
// Returns null if the token id isn't present (market relisted / token swap).
export function priceOfToken(m: MarketState, tokenId: string): number | null {
  const idx = m.clobTokenIds.indexOf(tokenId);
  if (idx < 0) return null;
  const p = m.outcomePrices[idx];
  return Number.isFinite(p) ? p : null;
}

export interface Prediction {
  side: Side;
  tokenId: string;
  suggestedPrice: number; // 0.05..0.95
  sizeUsd: number; // 1..100
}

// Effective entry price for the position: a SELL is the complement buy.
function effectivePrice(side: Side, suggestedPrice: number): number {
  return side === 'BUY' ? suggestedPrice : 1 - suggestedPrice;
}

export type RealizedOutcome =
  | {
      outcome: 'won' | 'lost';
      isCorrect: boolean;
      realizedPnlUsd: number;
      resolutionPrice: number;
    }
  | { outcome: 'void' };

// Score a prediction against a resolved/void market interpretation.
export function scoreResolved(
  pred: Prediction,
  interp: MarketInterpretation,
): RealizedOutcome {
  if (interp.status !== 'resolved') return { outcome: 'void' };

  const tokenWon = interp.winningTokenId === pred.tokenId;
  // The side's *bet* wins when: BUY and the token won, OR SELL and it lost.
  const betWins = pred.side === 'BUY' ? tokenWon : !tokenWon;
  const eff = effectivePrice(pred.side, pred.suggestedPrice);
  const realizedPnlUsd = betWins
    ? pred.sizeUsd * ((1 - eff) / eff)
    : -pred.sizeUsd;
  return {
    outcome: betWins ? 'won' : 'lost',
    isCorrect: betWins,
    realizedPnlUsd,
    resolutionPrice: interp.winningPrice,
  };
}

export interface MarkToMarket {
  markPrice: number; // current price of the rec's token
  markPnlUsd: number; // unrealized paper PnL at current price
  inMoney: boolean;
}

// Mark an open position to the current market price. `currentTokenPrice` is the
// live price of the recommendation's own token (use priceOfToken).
export function markToMarket(
  pred: Prediction,
  currentTokenPrice: number,
): MarkToMarket {
  const eff = effectivePrice(pred.side, pred.suggestedPrice);
  const curEff = pred.side === 'BUY' ? currentTokenPrice : 1 - currentTokenPrice;
  return {
    markPrice: currentTokenPrice,
    markPnlUsd: pred.sizeUsd * ((curEff - eff) / eff),
    inMoney: curEff > eff,
  };
}
