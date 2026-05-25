// Unit tests for the prediction track-record scoring math. This is the
// highest-risk logic (a sign error here silently misreports ZER0's accuracy),
// and it's pure, so it gets thorough coverage.

import { describe, it, expect } from 'vitest';
import {
  interpretMarket,
  priceOfToken,
  scoreResolved,
  markToMarket,
  type Prediction,
} from '@/lib/stats/scoring';

const YES = 'token-yes';
const NO = 'token-no';

describe('interpretMarket', () => {
  it('returns open when the market is not closed', () => {
    expect(
      interpretMarket({ closed: false, clobTokenIds: [YES, NO], outcomePrices: [0.6, 0.4] }),
    ).toEqual({ status: 'open' });
  });

  it('detects the winner when prices collapse to ~1/~0', () => {
    expect(
      interpretMarket({ closed: true, clobTokenIds: [YES, NO], outcomePrices: [1, 0] }),
    ).toEqual({ status: 'resolved', winningTokenId: YES, winningPrice: 1 });
    expect(
      interpretMarket({ closed: true, clobTokenIds: [YES, NO], outcomePrices: [0.005, 0.995] }),
    ).toEqual({ status: 'resolved', winningTokenId: NO, winningPrice: 0.995 });
  });

  it('treats a closed-but-uncollapsed market as void (e.g. 50/50 refund)', () => {
    expect(
      interpretMarket({ closed: true, clobTokenIds: [YES, NO], outcomePrices: [0.5, 0.5] }),
    ).toEqual({ status: 'void' });
    // closed but still mid-settlement (not yet at 1/0)
    expect(
      interpretMarket({ closed: true, clobTokenIds: [YES, NO], outcomePrices: [0.92, 0.08] }),
    ).toEqual({ status: 'void' });
  });

  it('voids malformed markets', () => {
    expect(
      interpretMarket({ closed: true, clobTokenIds: [YES], outcomePrices: [1] }),
    ).toEqual({ status: 'void' });
  });
});

describe('priceOfToken', () => {
  const m = { closed: false, clobTokenIds: [YES, NO], outcomePrices: [0.7, 0.3] };
  it('returns the index-aligned price', () => {
    expect(priceOfToken(m, YES)).toBe(0.7);
    expect(priceOfToken(m, NO)).toBe(0.3);
  });
  it('returns null for an unknown token', () => {
    expect(priceOfToken(m, 'nope')).toBeNull();
  });
});

describe('scoreResolved', () => {
  const resolvedYesWon = {
    status: 'resolved' as const,
    winningTokenId: YES,
    winningPrice: 1,
  };

  it('BUY on the winning token is correct, pnl = size*(1-p)/p', () => {
    const pred: Prediction = { side: 'BUY', tokenId: YES, suggestedPrice: 0.25, sizeUsd: 10 };
    const r = scoreResolved(pred, resolvedYesWon);
    expect(r).toMatchObject({ outcome: 'won', isCorrect: true });
    // 10 * (0.75 / 0.25) = 30
    if (r.outcome === 'won') expect(r.realizedPnlUsd).toBeCloseTo(30, 6);
  });

  it('BUY on the losing token loses the full stake', () => {
    const pred: Prediction = { side: 'BUY', tokenId: NO, suggestedPrice: 0.4, sizeUsd: 10 };
    const r = scoreResolved(pred, resolvedYesWon);
    expect(r).toMatchObject({ outcome: 'lost', isCorrect: false });
    if (r.outcome === 'lost') expect(r.realizedPnlUsd).toBeCloseTo(-10, 6);
  });

  it('SELL of the token that lost is correct; eff price = 1 - suggested', () => {
    // Sold YES at 0.8 (eff buy of NO at 0.2); YES lost so the SELL wins.
    const pred: Prediction = { side: 'SELL', tokenId: YES, suggestedPrice: 0.8, sizeUsd: 10 };
    const r = scoreResolved(pred, {
      status: 'resolved',
      winningTokenId: NO,
      winningPrice: 1,
    });
    expect(r).toMatchObject({ outcome: 'won', isCorrect: true });
    // 10 * (0.8 / 0.2) = 40
    if (r.outcome === 'won') expect(r.realizedPnlUsd).toBeCloseTo(40, 6);
  });

  it('SELL of the token that won loses the stake', () => {
    const pred: Prediction = { side: 'SELL', tokenId: YES, suggestedPrice: 0.8, sizeUsd: 10 };
    const r = scoreResolved(pred, resolvedYesWon);
    expect(r).toMatchObject({ outcome: 'lost', isCorrect: false });
    if (r.outcome === 'lost') expect(r.realizedPnlUsd).toBeCloseTo(-10, 6);
  });

  it('returns void for non-resolved interpretations', () => {
    const pred: Prediction = { side: 'BUY', tokenId: YES, suggestedPrice: 0.25, sizeUsd: 10 };
    expect(scoreResolved(pred, { status: 'void' })).toEqual({ outcome: 'void' });
    expect(scoreResolved(pred, { status: 'open' })).toEqual({ outcome: 'void' });
  });
});

describe('markToMarket', () => {
  it('BUY in the money when current price exceeds entry', () => {
    const pred: Prediction = { side: 'BUY', tokenId: YES, suggestedPrice: 0.25, sizeUsd: 10 };
    const mtm = markToMarket(pred, 0.5);
    expect(mtm.inMoney).toBe(true);
    // 10 * (0.5 - 0.25) / 0.25 = 10
    expect(mtm.markPnlUsd).toBeCloseTo(10, 6);
    expect(mtm.markPrice).toBe(0.5);
  });

  it('BUY underwater when current price drops below entry', () => {
    const pred: Prediction = { side: 'BUY', tokenId: YES, suggestedPrice: 0.5, sizeUsd: 10 };
    const mtm = markToMarket(pred, 0.4);
    expect(mtm.inMoney).toBe(false);
    expect(mtm.markPnlUsd).toBeCloseTo(-2, 6); // 10*(0.4-0.5)/0.5
  });

  it('SELL gains when the token price falls (complement rises)', () => {
    // Sold YES at 0.8 (eff 0.2); YES now 0.6 → curEff 0.4 > 0.2 → in money.
    const pred: Prediction = { side: 'SELL', tokenId: YES, suggestedPrice: 0.8, sizeUsd: 10 };
    const mtm = markToMarket(pred, 0.6);
    expect(mtm.inMoney).toBe(true);
    // 10 * (0.4 - 0.2) / 0.2 = 10
    expect(mtm.markPnlUsd).toBeCloseTo(10, 6);
  });
});
