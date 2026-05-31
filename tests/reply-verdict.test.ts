// The verdict gate decides fair/over/under from ZER0's estimate vs the market,
// and the opinion composer must always surface the numbers. These pin both.

import { describe, it, expect } from 'vitest';
import { validateReplyVerdict, type ReplyVerdict } from '@/lib/agents/validators';
import { composeOpinionTweet } from '@/lib/x/compose';

describe('validateReplyVerdict', () => {
  it('calls UNDER when ZER0 estimate is well above market', () => {
    const r = validateReplyVerdict({
      my_estimate: 0.6,
      market_price: 0.4,
      gap_pp: 0, // sloppy on purpose — recomputed
      verdict: 'FAIR', // sloppy on purpose — overridden
      confidence: 0.7,
      take: 'Market at 40%, I read this closer to 60%. Underpriced.',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.gap_pp).toBe(20);
      expect(r.value.verdict).toBe('UNDER');
    }
  });

  it('calls OVER when the market price is well above ZER0 estimate', () => {
    const r = validateReplyVerdict({
      my_estimate: 0.1,
      market_price: 0.4,
      gap_pp: 0,
      verdict: 'FAIR',
      confidence: 0.7,
      take: 'Market has this at 40%, I think more like 10%. Overpriced.',
    });
    expect(r.ok && r.value.verdict).toBe('OVER');
    expect(r.ok && r.value.gap_pp).toBe(-30);
  });

  it('calls FAIR inside the 10pp band', () => {
    const r = validateReplyVerdict({
      my_estimate: 0.42,
      market_price: 0.39,
      gap_pp: 99,
      verdict: 'OVER',
      confidence: 0.6,
      take: 'My read ~42% vs market 39%. Priced about right.',
    });
    expect(r.ok && r.value.verdict).toBe('FAIR');
  });

  it('rejects out-of-range estimates and too-short takes', () => {
    expect(validateReplyVerdict({ my_estimate: 1.5, market_price: 0.4, confidence: 0.5, take: 'x'.repeat(30) }).ok).toBe(false);
    expect(validateReplyVerdict({ my_estimate: 0.4, market_price: 0.4, confidence: 0.5, take: 'short' }).ok).toBe(false);
  });
});

describe('composeOpinionTweet', () => {
  const base: ReplyVerdict = {
    my_estimate: 0.6,
    market_price: 0.4,
    gap_pp: 20,
    verdict: 'UNDER',
    confidence: 0.7,
    take: 'Market has Swiss vote at 40%, I read it closer to 60%. Underpriced, room to run.',
  };

  it('uses the model take when usable', () => {
    const t = composeOpinionTweet({ question: 'Swiss initiative?', verdict: base });
    expect(t).toContain('60%');
    expect(t.length).toBeLessThanOrEqual(280);
  });

  it('falls back to a number-guaranteed template when the take is unusable', () => {
    // take is all links/@ → clampTweet strips it to empty → template fires.
    const v = { ...base, take: 'https://x.com/x @someone' };
    const t = composeOpinionTweet({ question: 'Will the Swiss initiative pass?', verdict: v });
    expect(t).toContain('40%'); // market price
    expect(t).toContain('60%'); // ZER0 estimate
    expect(t).toContain('+20pp'); // gap
    expect(t.toLowerCase()).toContain('underpricing');
  });
});
