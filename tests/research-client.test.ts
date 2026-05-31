import { describe, it, expect, vi, afterEach } from 'vitest';
import { runResearch, formatResearchForPrompt } from '@/lib/research/client';

afterEach(() => vi.unstubAllEnvs());

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({ ok, status, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

const tavilyBody = {
  query: 'swiss initiative',
  answer: 'Polls suggest the initiative is unlikely to pass.',
  results: [
    { title: 'Poll roundup', url: 'https://e.com/1', content: 'Latest polls show 35% support.', published_date: '2026-05-20' },
    { title: 'Analysis', url: 'https://e.com/2', content: 'Turnout will decide it.' },
  ],
};

describe('runResearch', () => {
  it('returns null and does not fetch when RESEARCH_ENABLED is unset', async () => {
    const spy = vi.fn();
    const res = await runResearch('swiss initiative', spy as unknown as typeof fetch);
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('parses Tavily snippets on success', async () => {
    vi.stubEnv('RESEARCH_ENABLED', 'true');
    vi.stubEnv('RESEARCH_API_KEY', 'test-key');
    const res = await runResearch('swiss initiative', fakeFetch(tavilyBody));
    expect(res?.answer).toContain('unlikely');
    expect(res?.snippets).toHaveLength(2);
    expect(res?.snippets[0].title).toBe('Poll roundup');
  });

  it('returns null on a non-ok response', async () => {
    vi.stubEnv('RESEARCH_ENABLED', 'true');
    vi.stubEnv('RESEARCH_API_KEY', 'test-key');
    expect(await runResearch('x', fakeFetch({}, false, 429))).toBeNull();
  });

  it('returns null when the request throws', async () => {
    vi.stubEnv('RESEARCH_ENABLED', 'true');
    vi.stubEnv('RESEARCH_API_KEY', 'test-key');
    const throwing = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect(await runResearch('x', throwing)).toBeNull();
  });
});

describe('formatResearchForPrompt', () => {
  it('returns empty string for null', () => {
    expect(formatResearchForPrompt(null)).toBe('');
  });

  it('includes the summary and bullet snippets', () => {
    const out = formatResearchForPrompt({
      query: 'q',
      answer: 'Summary line.',
      snippets: [{ title: 'T', content: 'Body text here.', url: 'u', published: '2026-05-20' }],
    });
    expect(out).toContain('Summary: Summary line.');
    expect(out).toContain('- T (2026-05-20): Body text here.');
  });

  it('caps at 6 snippets', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, content: `c${i}`, url: 'u' }));
    const out = formatResearchForPrompt({ query: 'q', answer: null, snippets: many });
    expect(out.split('\n').length).toBe(6);
  });
});
