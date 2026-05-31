// On-demand Polymarket lookup for chat.
//
// The chat pipeline is otherwise grounded only on the brain-tick scan set
// (market_scans, last 24h, deterministic). That makes ZER0 blind to any market
// it hasn't recently analyzed — a user asking "what about the US x Iran peace
// deal market?" gets "I haven't seen it" even though Polymarket has it live.
//
// This module closes that gap: given the user's query we hit Gamma's full
// catalog search, gate the hits on token overlap so we don't inject random
// markets into small-talk, and hand back a compact, authoritative view the
// system prompt can quote (live Yes price, volume, resolution date).
//
// Read-only: unlike the trade path (see telegram-bot/polymarket/market-search),
// a wrong match here only means ZER0 mentions a market the user didn't ask
// about — there is no order placed off the back of it.

import { type GammaMarket } from '../polymarket/gamma';
import { searchCatalog } from '../polymarket/catalog-cache';
import { containsWord } from './word-match';

export interface LiveMarketView {
  question: string;
  conditionId: string;
  /** Yes-outcome price in [0,1], or null if Gamma didn't price it. */
  yesPrice: number | null;
  noPrice: number | null;
  volumeUsd: number;
  liquidityUsd: number;
  /** ISO end date (resolution), or null. */
  endDate: string | null;
  resolutionSource: string | null;
}

// Words too generic to signal a specific market. Kept small on purpose — the
// goal is only to stop "hi"/"what's up"/"any tips" from triggering a search.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'you', 'your', 'youre', 'what', 'whats', 'about',
  'any', 'anything', 'tell', 'know', 'this', 'that', 'these', 'those', 'with',
  'have', 'has', 'had', 'will', 'would', 'could', 'should', 'can', 'got',
  'whatcha', 'gonna', 'wanna', 'think', 'thoughts', 'view', 'take', 'radar',
  'market', 'markets', 'bet', 'trade', 'going', 'happening', 'now', 'today',
  'currently', 'mentioned', 'earlier', 'said', 'yeah', 'yes', 'nah', 'hey',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

// "Significant" = long enough and meaningful enough to point at a real market.
// Requires at least one letter (so bare years like "2026" don't count) and not
// a stopword.
export function significantTokens(s: string): string[] {
  return tokenize(s).filter(
    (t) => t.length >= 4 && /[a-z]/.test(t) && !STOPWORDS.has(t),
  );
}

function toView(m: GammaMarket): LiveMarketView {
  const yes = m.outcomePrices[0] != null ? parseFloat(m.outcomePrices[0]) : NaN;
  const no = m.outcomePrices[1] != null ? parseFloat(m.outcomePrices[1]) : NaN;
  return {
    question: m.question,
    conditionId: m.conditionId,
    yesPrice: Number.isFinite(yes) ? yes : null,
    noPrice: Number.isFinite(no) ? no : null,
    volumeUsd: m.volumeNum ?? 0,
    liquidityUsd: parseFloat(m.liquidity ?? '0') || 0,
    endDate: m.endDate ?? null,
    resolutionSource: m.resolutionSource ? m.resolutionSource : null,
  };
}

export interface LookupOpts {
  limit?: number;
  // Minimum number of the query's significant tokens that must appear in a
  // market question for it to count as a match. Defaults to 1, which suits
  // chat (the user deliberately named a market). Callers fed noisier input —
  // e.g. the X mention-respond cron, where most messages are hype chatter that
  // coincidentally share ONE common word ("send", "good", "soon") with some
  // unrelated market — should raise this to 2+ to avoid spurious matches.
  minOverlap?: number;
  // When true, a Gamma search failure RE-THROWS instead of being swallowed as
  // []. Chat wants the swallow (a failed lookup just means "no live block").
  // The mention cron wants the throw, so it can tell a transient Gamma error
  // (retry the mention) apart from a genuine no-match (stay silent) — otherwise
  // a Gamma blip permanently marks a real question 'skipped_ungrounded'.
  throwOnSearchError?: boolean;
  // Injectable for tests.
  search?: typeof searchCatalog;
}

/**
 * Resolve a free-text query to the live Polymarket markets it most likely
 * refers to. Returns [] for non-market chatter (no significant tokens), on a
 * Gamma failure, or when nothing the search returned actually overlaps the
 * query — so the caller can simply skip the live-data block.
 */
export async function lookupLiveMarkets(
  query: string,
  opts: LookupOpts = {},
): Promise<LiveMarketView[]> {
  const search = opts.search ?? searchCatalog;
  const limit = opts.limit ?? 4;
  const minOverlap = opts.minOverlap ?? 1;

  // Distinct significant tokens. Dedupe matters: overlap below is meant to
  // measure how many DIFFERENT topic words a market question covers, so a query
  // that merely repeats one common word ("even ... even") must not score 2.
  const tokens = [...new Set(significantTokens(query))];
  // Gate: a message with no significant token ("hi", "any tips?") is not about
  // a specific market — don't burn a Gamma call or risk injecting noise.
  if (tokens.length === 0) return [];

  let hits: GammaMarket[];
  try {
    hits = await search(query, 12);
  } catch (err) {
    console.warn('[market-lookup] gamma search failed', err);
    if (opts.throwOnSearchError) throw err;
    return [];
  }
  if (hits.length === 0) return [];

  // Re-rank by how many of the query's significant tokens appear in the
  // market question. Gamma's relevance is decent but fuzzy; requiring overlap
  // keeps us from surfacing a tangential hit when the user named something
  // specific. Tie-break on liquidity (deeper markets first).
  const scored = hits
    .map((m) => {
      const hay = m.question.toLowerCase();
      let overlap = 0;
      for (const t of tokens) if (containsWord(hay, t)) overlap += 1;
      return { m, overlap };
    })
    .filter((x) => x.overlap >= minOverlap)
    .sort(
      (a, b) =>
        b.overlap - a.overlap ||
        (parseFloat(b.m.liquidity ?? '0') || 0) -
          (parseFloat(a.m.liquidity ?? '0') || 0),
    );

  return scored.slice(0, limit).map((x) => toView(x.m));
}

function compactUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

// Rendered into the system prompt as the "Live Polymarket data" block. Empty
// string when there's nothing to show, so the caller can drop the section.
export function formatLiveMarketsForSystem(markets: LiveMarketView[]): string {
  if (markets.length === 0) return '';
  return markets
    .map((m) => {
      const yes =
        m.yesPrice != null
          ? `Yes ${(m.yesPrice * 100).toFixed(0)}% (${m.yesPrice.toFixed(3)})`
          : 'Yes price unknown';
      const vol = m.volumeUsd > 0 ? `${compactUsd(m.volumeUsd)} volume` : 'thin volume';
      const ends = m.endDate ? `resolves ${m.endDate.slice(0, 10)}` : 'no end date';
      const src = m.resolutionSource ? `; source: ${m.resolutionSource}` : '';
      return `- "${m.question}" — ${yes}, ${vol}, ${ends}${src}`;
    })
    .join('\n');
}
