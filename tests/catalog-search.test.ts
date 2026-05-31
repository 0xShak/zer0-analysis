// The catalog search replaced Gamma's /public-search (Cloudflare-blocked from
// prod). Because it matches words across thousands of markets, the danger is
// false positives from common words; these pin the rarity gate that stops them.

import { describe, it, expect } from 'vitest';
import { rankCatalog, type CachedMarket } from '@/lib/polymarket/catalog-cache';

function mkt(question: string): CachedMarket {
  return { conditionId: question, question, yes: 0.5, no: 0.5, vol: 1, liq: 1, end: null, src: null };
}

// Enough filler markets containing "before"/"next" that those words become
// COMMON (df > the rarity threshold of 25) and therefore non-distinctive.
const filler = Array.from({ length: 60 }, (_, i) =>
  mkt(`Filler event ${i}: will it happen before the next deadline?`),
);
const swiss = mkt(
  'Will the No to ten million Switzerland initiative be approved in the 2026 popular vote?',
);
const moonshot = mkt('Will Moonshot have the best Math AI model at the end of May 2026?');
const catalog = [...filler, swiss, moonshot];

describe('rankCatalog rarity gate', () => {
  it('grounds a question with two distinctive tokens', () => {
    const hits = rankCatalog('what is your read on the Switzerland initiative market?', catalog);
    expect(hits[0]?.question).toBe(swiss.question);
  });

  it('stays silent on chatter that only shares common words', () => {
    // "before" + "next" are common across the catalog → not distinctive.
    expect(rankCatalog('back into the box before continuing the next leg up', catalog)).toEqual([]);
  });

  it('needs TWO distinctive tokens, not one', () => {
    // Only "switzerland" is distinctive here ("approved" appears nowhere else,
    // but a single rare word is a fluke, not a reference).
    expect(rankCatalog('switzerland', catalog)).toEqual([]);
  });

  it('does not ground idioms via substring matches', () => {
    // "let him do the math, give it a shot" — "math" is whole-word (1), but
    // "shot" must NOT match "MoonSHOT", so only 1 distinctive token → silent.
    expect(rankCatalog('let him do the math, give it a shot', catalog)).toEqual([]);
  });
});
