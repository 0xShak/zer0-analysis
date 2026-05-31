// Web research via Tavily, used to give ZER0's X mention takes fresh news
// context before it estimates a probability. Swappable: the rest of the app
// only depends on `runResearch()` returning text-friendly snippets, so Tavily
// can later be replaced (Exa/Brave/OpenAI web_search) by editing only this file.
//
// Follows the lib/polymarket/gamma.ts pattern: native fetch + AbortController
// timeout. NEVER throws — returns null on any failure (disabled flag, missing
// key, non-ok, abort) so the caller degrades gracefully to a non-research reply.

import { env } from '../env';
import { logUsage } from '../cost/log';

const TAVILY_TIMEOUT_MS = 5_000; // well inside the 60s Inngest step budget
// Tavily bills per search (no token usage reported). Flat estimate so research
// spend still shows up in the agent_usage ledger alongside model costs.
const TAVILY_COST_PER_SEARCH = 0.008;

export interface ResearchSnippet {
  title: string;
  content: string;
  url: string;
  published?: string;
}

export interface ResearchResult {
  query: string;
  /** Tavily's one-line synthesized answer, when present. */
  answer: string | null;
  snippets: ResearchSnippet[];
}

interface TavilyResponse {
  query?: string;
  answer?: string | null;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string;
  }>;
}

/**
 * Search the web for recent context on `query`. Returns null when research is
 * disabled or anything goes wrong — the caller treats null as "no extra
 * context" and proceeds (or falls back). `fetchImpl` is injectable for tests.
 */
export async function runResearch(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResearchResult | null> {
  if ((process.env.RESEARCH_ENABLED ?? 'false') !== 'true') return null;
  const q = query.trim();
  if (!q) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${env.RESEARCH_BASE_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        api_key: env.RESEARCH_API_KEY,
        query: q,
        search_depth: 'basic',
        topic: 'news',
        max_results: 5,
        days: 14,
        include_answer: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[research] tavily ${res.status}`);
      return null;
    }
    const data = (await res.json()) as TavilyResponse;
    const snippets: ResearchSnippet[] = (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      content: r.content ?? '',
      url: r.url ?? '',
      published: r.published_date,
    }));
    // Fire-and-forget spend accounting (never throws).
    void logUsage({
      provider: 'tavily',
      model: 'tavily-search',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: TAVILY_COST_PER_SEARCH,
      step: 'x-mention-research',
    }).catch(() => {});
    return { query: q, answer: data.answer ?? null, snippets };
  } catch (err) {
    console.warn('[research] tavily request failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render research into a compact prompt block for the analyzer. Empty string
 * when there's nothing (so the prompt section can be dropped). Caps size so a
 * long result set can't bloat the reasoning-model input.
 */
export function formatResearchForPrompt(r: ResearchResult | null): string {
  if (!r) return '';
  const lines: string[] = [];
  if (r.answer) lines.push(`Summary: ${r.answer.slice(0, 400)}`);
  for (const s of r.snippets.slice(0, 6)) {
    const when = s.published ? ` (${s.published.slice(0, 10)})` : '';
    const body = s.content.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (body) lines.push(`- ${s.title}${when}: ${body}`);
  }
  return lines.join('\n');
}
