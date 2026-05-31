import { describe, it, expect } from 'vitest';
import { containsWord } from '@/lib/chat/word-match';

describe('containsWord', () => {
  it('matches whole words', () => {
    expect(containsWord('will moonshot have the best math ai model?', 'math')).toBe(true);
    expect(containsWord('the swiss initiative vote', 'initiative')).toBe(true);
  });

  it('does NOT match a word embedded in a longer word (the substring bug)', () => {
    expect(containsWord('will moonshot win', 'shot')).toBe(false); // "shot" ⊄ "moonshot"
    expect(containsWord('seven nominating elections', 'even')).toBe(false); // "even" ⊄ "seven"
    expect(containsWord('hong soon-heon wins', 'soon')).toBe(true); // hyphen IS a boundary
  });

  it('is empty-safe', () => {
    expect(containsWord('anything', '')).toBe(false);
  });
});
