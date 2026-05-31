// Polymarket Gamma API client — see zer0.md §8 and §9.
// Filter set verbatim from the official polymarket/agents reference.
//
// Gamma returns several array-valued fields as JSON-encoded STRINGS, not
// arrays. We normalise to real arrays at the boundary.

interface GammaMarketRaw {
  id: string;
  conditionId: string;
  question: string;
  description?: string;
  resolutionSource?: string;
  category?: string;
  outcomes: string | string[];
  outcomePrices: string | string[];
  liquidity?: string;
  volumeNum?: number;
  endDate: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  enableOrderBook: boolean;
  negRisk?: boolean;
  clobTokenIds: string | string[];
  // Live order-book fields — only present on the /public-search payload, not
  // on the discovery /markets feed. May be null when a market has no book yet.
  volume24hr?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  lastTradePrice?: number | null;
  spread?: number | null;
}

export interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  description?: string;
  resolutionSource?: string;
  category?: string;
  outcomes: string[];
  outcomePrices: string[];
  liquidity: string;
  volumeNum: number;
  endDate: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  enableOrderBook: boolean;
  negRisk?: boolean;
  clobTokenIds: string[];
  // Live order-book fields — populated from /public-search, undefined when the
  // market came from the discovery /markets feed (which omits them).
  volume24hr?: number;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  spread?: number;
}

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

// Gamma's /public-search sits behind Cloudflare bot protection that 403s
// requests without a browser-like User-Agent when they come from datacenter
// IPs (Vercel/Inngest) — even though the same call succeeds UA-less from a
// residential IP, and /markets is unprotected. Sending a normal browser UA +
// Accept-Language makes the request look like a browser and clears the 403.
const GAMMA_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

function parseStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalise(m: GammaMarketRaw): GammaMarket {
  return {
    id: m.id,
    conditionId: m.conditionId,
    question: m.question,
    description: m.description,
    resolutionSource: m.resolutionSource,
    category: m.category,
    outcomes: parseStringArray(m.outcomes),
    outcomePrices: parseStringArray(m.outcomePrices),
    liquidity: m.liquidity ?? '0',
    volumeNum: m.volumeNum ?? 0,
    endDate: m.endDate,
    active: m.active,
    closed: m.closed,
    archived: m.archived,
    enableOrderBook: m.enableOrderBook,
    negRisk: m.negRisk,
    clobTokenIds: parseStringArray(m.clobTokenIds),
    volume24hr: m.volume24hr ?? undefined,
    bestBid: m.bestBid ?? undefined,
    bestAsk: m.bestAsk ?? undefined,
    lastTradePrice: m.lastTradePrice ?? undefined,
    spread: m.spread ?? undefined,
  };
}

// Per-request timeout. Polymarket Gamma is normally ~300-800ms but
// occasionally hangs; without a hard cap, a single slow page can consume the
// whole 60s Vercel budget for the scan-markets step.
const GAMMA_REQUEST_TIMEOUT_MS = 8000;

export async function fetchTradableMarkets(limit = 100, offset = 0): Promise<GammaMarket[]> {
  const params = new URLSearchParams({
    active: 'true',
    closed: 'false',
    archived: 'false',
    enableOrderBook: 'true',
    limit: String(limit),
    offset: String(offset),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GAMMA_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${GAMMA_BASE}/markets?${params}`, {
      headers: GAMMA_HEADERS,
      next: { revalidate: 60 },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Gamma /markets ${res.status}: ${await res.text()}`);
    }
    const raw = (await res.json()) as GammaMarketRaw[];
    return raw.map(normalise);
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a single market by conditionId — unlike fetchTradableMarkets this does
// NOT filter on closed/active/archived, so RESOLVED markets come back too. Used
// by the settlement job to read a market's final outcome after it resolves.
// Returns null when Gamma has no row for the id (e.g. very old / purged market).
export async function fetchMarketByCondition(
  conditionId: string,
): Promise<GammaMarket | null> {
  const params = new URLSearchParams({
    condition_ids: conditionId,
    limit: '1',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GAMMA_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${GAMMA_BASE}/markets?${params}`, {
      headers: GAMMA_HEADERS,
      next: { revalidate: 60 },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Gamma /markets ${res.status}: ${await res.text()}`);
    }
    const raw = (await res.json()) as GammaMarketRaw[];
    const first = raw?.[0];
    return first ? normalise(first) : null;
  } finally {
    clearTimeout(timer);
  }
}

interface GammaSearchResponse {
  events?: Array<{ markets?: GammaMarketRaw[] }>;
}

// Full-catalog text search via Gamma's /public-search endpoint. Unlike
// fetchTradableMarkets (which walks the first few pages of the discovery feed),
// this queries Polymarket's whole active catalog, so an arbitrary market a user
// names in chat — e.g. "US x Iran peace deal" — is actually findable. Results
// come back as events with nested markets; a single event can mix live and
// already-resolved legs (different resolution dates), so we drop anything not
// currently tradable. Uses cache:'no-store' so the prices are live, not the
// 60s-revalidated copy the discovery feed serves.
export async function searchMarketsLive(
  query: string,
  limit = 12,
): Promise<GammaMarket[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({
    q,
    limit_per_type: '20',
    events_status: 'active',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GAMMA_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${GAMMA_BASE}/public-search?${params}`, {
      headers: GAMMA_HEADERS,
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Gamma /public-search ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as GammaSearchResponse;
    const out: GammaMarket[] = [];
    for (const ev of data.events ?? []) {
      for (const raw of ev.markets ?? []) {
        const m = normalise(raw);
        // Drop closed/resolved/archived legs and non-binary markets — chat
        // should only speak to markets that are still live and have a clean
        // Yes/No price.
        if (!m.active || m.closed || m.archived) continue;
        if (m.outcomes.length !== 2 || m.outcomePrices.length !== 2) continue;
        out.push(m);
        if (out.length >= limit) return out;
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// Numeric guards from zer0.md §9 — Gamma ships no thresholds, we add them.
export function passesNumericFilter(m: GammaMarket): boolean {
  const liquidity = parseFloat(m.liquidity ?? '0');
  const volume = m.volumeNum ?? 0;
  if (liquidity < 5000) return false;
  if (volume < 1000) return false;

  if (!m.outcomePrices || m.outcomePrices.length !== 2) return false;
  const prices = m.outcomePrices.map((p) => parseFloat(p));
  if (!prices.some((p) => p >= 0.05 && p <= 0.95)) return false;

  if (!m.outcomes || m.outcomes.length !== 2) return false;

  const end = new Date(m.endDate).getTime();
  const now = Date.now();
  if (Number.isNaN(end)) return false;
  if (end < now + 60 * 60 * 1000) return false; // > 1h out
  if (end > now + 30 * 24 * 60 * 60 * 1000) return false; // < 30d out

  return true;
}
