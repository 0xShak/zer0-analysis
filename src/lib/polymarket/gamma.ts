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
}

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

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
      headers: { Accept: 'application/json' },
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
      headers: { Accept: 'application/json' },
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
