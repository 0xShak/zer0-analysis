// The live-lookup gate is the thing that keeps ZER0 from injecting random
// Polymarket markets into ordinary chatter while still surfacing the right
// market when a user actually names one. These tests pin that behaviour with
// an injected fake search so no network is touched.

import { describe, it, expect } from 'vitest';
import { lookupLiveMarkets } from '@/lib/chat/market-lookup';
import type { GammaMarket } from '@/lib/polymarket/gamma';

function market(over: Partial<GammaMarket> & { question: string }): GammaMarket {
  return {
    id: 'id',
    conditionId: '0xabc',
    outcomes: ['Yes', 'No'],
    outcomePrices: ['0.25', '0.75'],
    liquidity: '50000',
    volumeNum: 1_000_000,
    endDate: '2026-05-31T00:00:00Z',
    active: true,
    closed: false,
    archived: false,
    enableOrderBook: true,
    clobTokenIds: ['1', '2'],
    ...over,
  };
}

const iran = market({
  question: 'US x Iran permanent peace deal by May 31, 2026?',
  conditionId: '0xiran',
});

describe('lookupLiveMarkets', () => {
  it('finds and returns a named market', async () => {
    const hits = await lookupLiveMarkets('what about US x Iran peace deals?', {
      search: async () => [iran],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].conditionId).toBe('0xiran');
    expect(hits[0].yesPrice).toBeCloseTo(0.25);
    expect(hits[0].noPrice).toBeCloseTo(0.75);
    expect(hits[0].endDate).toBe('2026-05-31T00:00:00Z');
  });

  it('does not search or inject for small-talk (no significant tokens)', async () => {
    let called = false;
    const hits = await lookupLiveMarkets('hey, what up?', {
      search: async () => {
        called = true;
        return [iran];
      },
    });
    expect(called).toBe(false);
    expect(hits).toEqual([]);
  });

  it('drops hits that do not overlap the query (fuzzy Gamma match)', async () => {
    const unrelated = market({ question: 'Will the Lakers win the title?' });
    const hits = await lookupLiveMarkets('US x Iran peace deal', {
      search: async () => [unrelated],
    });
    expect(hits).toEqual([]);
  });

  it('ranks higher-overlap hits first', async () => {
    const weak = market({ question: 'Iran nuclear program update', conditionId: '0xweak' });
    const hits = await lookupLiveMarkets('US Iran peace deal', {
      search: async () => [weak, iran],
    });
    expect(hits[0].conditionId).toBe('0xiran');
  });

  it('returns [] (not a throw) when search fails', async () => {
    const hits = await lookupLiveMarkets('Iran peace deal', {
      search: async () => {
        throw new Error('gamma down');
      },
    });
    expect(hits).toEqual([]);
  });
});
