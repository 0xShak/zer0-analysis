// In-memory search over a cached snapshot of Polymarket's active catalog.
//
// Replaces the Cloudflare-blocked /public-search (see migration 0014): the
// catalog-refresh cron writes the active catalog to market_catalog_cache via
// refreshCatalog(); searchCatalog() reads that snapshot and ranks it by query
// overlap, returning the same GammaMarket[] shape /public-search did — so it's
// a drop-in for lookupLiveMarkets' injectable search, and the precise
// minOverlap gate still runs on top in market-lookup.ts.

import { fetchActiveCatalog, type GammaMarket } from './gamma';
import { createAdminClient } from '../supabase/admin';
import type { Json } from '../database.types';

// Compact record we persist per market — only the fields toView/search need,
// to keep the JSON blob small (a few hundred KB rather than several MB).
interface CachedMarket {
  conditionId: string;
  question: string;
  yes: number | null;
  no: number | null;
  vol: number;
  liq: number;
  end: string | null;
  src: string | null;
}

function toCached(m: GammaMarket): CachedMarket {
  const yes = m.outcomePrices[0] != null ? parseFloat(m.outcomePrices[0]) : NaN;
  const no = m.outcomePrices[1] != null ? parseFloat(m.outcomePrices[1]) : NaN;
  return {
    conditionId: m.conditionId,
    question: m.question,
    yes: Number.isFinite(yes) ? yes : null,
    no: Number.isFinite(no) ? no : null,
    vol: m.volumeNum ?? 0,
    liq: parseFloat(m.liquidity ?? '0') || 0,
    end: m.endDate ?? null,
    src: m.resolutionSource || null,
  };
}

// Reconstruct a GammaMarket from the compact record so searchCatalog stays a
// drop-in for the old /public-search-based search (toView reads these fields).
function toGamma(c: CachedMarket): GammaMarket {
  return {
    id: c.conditionId,
    conditionId: c.conditionId,
    question: c.question,
    outcomes: ['Yes', 'No'],
    outcomePrices: [c.yes != null ? String(c.yes) : '', c.no != null ? String(c.no) : ''],
    liquidity: String(c.liq),
    volumeNum: c.vol,
    endDate: c.end ?? '',
    active: true,
    closed: false,
    archived: false,
    enableOrderBook: true,
    clobTokenIds: [],
    resolutionSource: c.src ?? undefined,
  };
}

// Snapshots the active catalog into market_catalog_cache. Called by the
// zer0-catalog-refresh cron. Returns the number of markets stored.
export async function refreshCatalog(maxMarkets = 5000): Promise<number> {
  const markets = await fetchActiveCatalog(maxMarkets);
  // A transient Gamma failure can yield very few markets; don't clobber a good
  // snapshot with a near-empty one.
  if (markets.length === 0) return 0;
  const cached = markets.map(toCached);
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('market_catalog_cache')
    .update({
      markets: cached as unknown as Json,
      market_count: cached.length,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);
  if (error) throw new Error(`catalog cache write failed: ${error.message}`);
  return cached.length;
}

// Per-instance memo so chat/mention bursts don't re-read the blob every call.
let mem: { at: number; markets: CachedMarket[] } | undefined;
const MEM_TTL_MS = 60_000;

async function loadCatalog(): Promise<CachedMarket[]> {
  if (mem && Date.now() - mem.at < MEM_TTL_MS) return mem.markets;
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('market_catalog_cache')
    .select('markets')
    .eq('id', 1)
    .single();
  const markets = ((data?.markets as CachedMarket[] | undefined) ?? []) as CachedMarket[];
  mem = { at: Date.now(), markets };
  return markets;
}

// Words too short/common to signal a specific market. Kept minimal — this is
// just the candidate filter; market-lookup applies the real significant-token
// + minOverlap gate to whatever we return.
const STOP = new Set([
  'the', 'and', 'for', 'will', 'with', 'from', 'that', 'this', 'what', 'your',
  'about', 'have', 'has', 'are', 'be', 'in', 'on', 'of', 'to', 'a', 'an',
  'market', 'markets', 'bet', 'odds', 'price', 'read', 'thoughts', 'think',
]);

function words(s: string): string[] {
  return [
    ...new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP.has(w)),
    ),
  ];
}

// Drop-in for the old searchMarketsLive: returns up to `limit` candidate
// markets from the cached catalog, ranked by how many distinct query words
// appear in the question (tie-break: total volume).
export async function searchCatalog(query: string, limit = 12): Promise<GammaMarket[]> {
  const qw = words(query);
  if (qw.length === 0) return [];
  const catalog = await loadCatalog();
  const scored: { c: CachedMarket; overlap: number }[] = [];
  for (const c of catalog) {
    const hay = c.question.toLowerCase();
    let overlap = 0;
    for (const w of qw) if (hay.includes(w)) overlap += 1;
    if (overlap > 0) scored.push({ c, overlap });
  }
  scored.sort((a, b) => b.overlap - a.overlap || b.c.vol - a.c.vol);
  return scored.slice(0, limit).map((x) => toGamma(x.c));
}
