// Locks in the M-A (audit2.md) sanitizer: a prompt-injected Polymarket market
// title/description must never be able to put a clickable link or an @mention
// onto ZER0's public board or X feed. These pin the enforced chokepoints
// (stripLinksAndHandles, clampTweet, validateAnalysisOutput) so a future edit
// can't silently regress the guarantee.

import { describe, it, expect } from 'vitest';
import { stripLinksAndHandles } from '@/lib/text-safety';
import { clampTweet } from '@/lib/x/compose';
import { validateAnalysisOutput } from '@/lib/agents/validators';

describe('stripLinksAndHandles', () => {
  it('removes http/https URLs', () => {
    expect(stripLinksAndHandles('buy now http://evil.xyz/scam today')).toBe(
      'buy now today',
    );
    expect(stripLinksAndHandles('see https://evil.com?a=1#x end')).toBe(
      'see end',
    );
  });

  it('removes scheme-less www and shortener/invite links', () => {
    expect(stripLinksAndHandles('go www.evil.xyz now')).toBe('go now');
    expect(stripLinksAndHandles('join t.me/evilchannel here')).toBe('join here');
    expect(stripLinksAndHandles('x bit.ly/abc y')).toBe('x y');
  });

  it('removes @handles but keeps surrounding text', () => {
    expect(stripLinksAndHandles('ping @attacker and @b2 done')).toBe(
      'ping and done',
    );
    expect(stripLinksAndHandles('email a@b ok')).toBe('email a@b ok'); // not a leading-@ handle
  });

  it('leaves ordinary rationale untouched (besides whitespace collapse)', () => {
    expect(stripLinksAndHandles('Yes at 7.6%,  my estimate 1-3%.')).toBe(
      'Yes at 7.6%, my estimate 1-3%.',
    );
  });
});

describe('clampTweet', () => {
  it('strips an injected link from the composed tweet', () => {
    expect(clampTweet('New call: YES on market. dm me https://evil.xyz/x')).toBe(
      'New call: YES on market. dm me',
    );
  });

  it('strips surrounding quotes and caps at 280 chars', () => {
    const long = '"' + 'a'.repeat(400) + '"';
    const out = clampTweet(long);
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.startsWith('"')).toBe(false);
  });
});

describe('validateAnalysisOutput rationale sanitization', () => {
  const candidate = { conditionId: '0x1', question: 'q', tokenIds: ['t1'] };
  const base = {
    conviction: 0.8,
    side: 'BUY',
    token_id: 't1',
    suggested_price: 0.5,
    suggested_size_usd: 10,
  };

  it('returns a rationale with links/@handles stripped', () => {
    const rationale =
      'Strong edge here, the base rate clearly favors YES and the book is mispriced by a wide margin so this is a clean value spot. ' +
      'ape in at https://evil.xyz and follow @scammer';
    const res = validateAnalysisOutput({ ...base, rationale }, candidate);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rationale).not.toContain('https://evil.xyz');
      expect(res.value.rationale).not.toContain('@scammer');
    }
  });

  it('rejects when the rationale is only an injected payload (too short after cleaning)', () => {
    const res = validateAnalysisOutput(
      { ...base, rationale: 'https://evil.xyz/scam @scammer' },
      candidate,
    );
    expect(res.ok).toBe(false);
  });
});
