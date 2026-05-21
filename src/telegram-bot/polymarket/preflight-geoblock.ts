// Geoblock pre-flight for the bot's egress IP.
//
// Background: V2 trade submission (POST /order, DELETE /order, etc.) is
// geoblocked per Polymarket's docs. With trades originating from the bot
// rather than the user's browser, the bot's egress region is now load-
// bearing. We refuse to register trade handlers if this returns blocked.
// Close-only regions (SG, PL, TH, TW) pass `blocked:false` here but
// reject opening positions — those need a separate client-side check
// (see Caveats in the spec).

export interface GeoblockStatus {
  blocked: boolean;
  ip: string;
  country: string;
  region: string;
}

const ENDPOINT = 'https://polymarket.com/api/geoblock';

// Subset of "close-only" jurisdictions per docs.polymarket.com/api-reference/geoblock.
// Membership here means: even with blocked=false, do NOT allow open-position
// orders — only allow closes.
const CLOSE_ONLY_COUNTRIES = new Set(['SG', 'PL', 'TH', 'TW']);

export interface PreflightResult {
  status: GeoblockStatus;
  /** True only if open-position orders are allowed from this egress. */
  canOpenPositions: boolean;
  /** True if we'd at least be allowed to close existing positions. */
  canClosePositions: boolean;
}

export async function checkGeoblock(
  fetchImpl: typeof fetch = fetch,
): Promise<PreflightResult> {
  const res = await fetchImpl(ENDPOINT, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`geoblock preflight: ${res.status} ${res.statusText}`);
  }
  const status = (await res.json()) as GeoblockStatus;
  const closeOnly = CLOSE_ONLY_COUNTRIES.has(status.country?.toUpperCase?.() ?? '');
  return {
    status,
    canOpenPositions: !status.blocked && !closeOnly,
    canClosePositions: !status.blocked,
  };
}

/**
 * Block-on-failure variant for `bot.start()` — throws when the egress IP
 * cannot place trades at all. Use the lower-level checkGeoblock when you
 * want to inspect close-only state.
 */
export async function assertCanTrade(
  fetchImpl: typeof fetch = fetch,
): Promise<PreflightResult> {
  const result = await checkGeoblock(fetchImpl);
  if (!result.canClosePositions) {
    throw new Error(
      `[preflight-geoblock] Bot egress IP ${result.status.ip} is geoblocked from Polymarket (${result.status.country}/${result.status.region}). Refusing to register trade handlers. Move the bot to a non-blocked region (sa-saopaulo-1, eu-stockholm-1, eu-zurich-1, me-jeddah-1, ap-mumbai-1, mx-queretaro-1) or wire POLYMARKET_RELAY_URL to a relay there.`,
    );
  }
  return result;
}

const HOURLY = 60 * 60 * 1000;

/**
 * Background interval that re-runs the pre-flight every hour. If the IP
 * status changes (e.g. CDN routing flip), the supplied `onChange` callback
 * fires so the caller can disable trade handlers mid-flight.
 */
export function startGeoblockWatcher(opts: {
  initial: PreflightResult;
  onChange: (next: PreflightResult) => void;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}): { stop: () => void } {
  const interval = opts.intervalMs ?? HOURLY;
  let last = opts.initial;
  const handle = setInterval(() => {
    void (async () => {
      try {
        const next = await checkGeoblock(opts.fetchImpl);
        if (
          next.status.blocked !== last.status.blocked ||
          next.status.country !== last.status.country ||
          next.canOpenPositions !== last.canOpenPositions
        ) {
          last = next;
          opts.onChange(next);
        }
      } catch (err) {
        console.error('[preflight-geoblock] watcher failed', err);
      }
    })();
  }, interval);
  // Prevent the timer from holding the event loop open during shutdown.
  if (typeof handle.unref === 'function') handle.unref();
  return {
    stop: () => clearInterval(handle),
  };
}
