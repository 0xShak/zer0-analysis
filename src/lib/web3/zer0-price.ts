// Live $ZER0/USD price → the USD-pegged $ZER0 amount for a PRO unlock.
//
// PRO is priced in dollars (PRO_PRICE_USD) but paid in $ZER0, so at quote time
// we read the current token price and convert. The resulting amount is locked
// onto the pro_orders row and verified exactly on-chain — the price can drift
// afterwards without affecting an in-flight order.
//
// Source: DexScreener's keyless tokens endpoint (ZER0_PRICE_SOURCE_URL). It
// returns every pair the token trades in; we take the Base pair with the
// deepest USD liquidity as the reference price (deepest pool = least
// manipulable, most representative).

import { getAddress } from 'viem';
import { env } from '../env';
import { getZer0Decimals } from './zer0-payment';

interface DexPair {
  chainId?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
}

export interface Zer0Quote {
  /** Exact transfer amount to expect/verify, in token base units. */
  amountBaseUnits: bigint;
  /** Human-readable $ZER0 amount (display only), e.g. "48250.5". */
  amountZer0: string;
  /** The reference USD price per $ZER0 used for the conversion. */
  priceUsd: number;
  /** The USD target this amount is pegged to. */
  priceUsdTarget: number;
}

/** Fetch the reference $ZER0/USD price from the deepest Base pool. Throws on
 *  any failure or implausible value — a bad price must never become a quote. */
export async function fetchZer0PriceUsd(): Promise<number> {
  const url = env.ZER0_PRICE_SOURCE_URL.replace(
    '{token}',
    getAddress(env.ZER0_TOKEN_ADDRESS),
  );
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    // Never serve a stale price from any intermediary cache.
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`price source returned ${res.status}`);
  }
  const body = (await res.json()) as { pairs?: DexPair[] };
  const pairs = body.pairs ?? [];

  // Prefer Base pairs; fall back to any pair if the source doesn't tag chains.
  const basePairs = pairs.filter((p) => p.chainId === 'base');
  const pool = (basePairs.length > 0 ? basePairs : pairs)
    .filter((p) => p.priceUsd && Number(p.priceUsd) > 0)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

  const price = pool ? Number(pool.priceUsd) : NaN;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('no usable $ZER0 price from source');
  }
  return price;
}

/**
 * Quote `priceUsdTarget` dollars worth of $ZER0 at the live price.
 *
 * The conversion is done entirely in BigInt to stay exact at the token's full
 * decimals (a float `target / price * 10^18` would lose precision for the large
 * token counts a sub-cent memecoin price implies). We scale the USD price to 12
 * significant digits, then:
 *
 *   amountBaseUnits = (target × 10^decimals × 10^12) / round(price × 10^12)
 */
export async function quoteZer0ForUsd(
  priceUsdTarget: number,
): Promise<Zer0Quote> {
  const [priceUsd, decimals] = await Promise.all([
    fetchZer0PriceUsd(),
    getZer0Decimals(),
  ]);

  const PRICE_SCALE = 12;
  const priceScaled = BigInt(Math.round(priceUsd * 10 ** PRICE_SCALE));
  if (priceScaled <= BigInt(0)) {
    throw new Error('price underflow — token price too small to quote');
  }

  // target × 10^decimals, as an integer (target may have cents).
  const targetCents = BigInt(Math.round(priceUsdTarget * 100));
  const numerator =
    targetCents *
    BigInt(10) ** BigInt(decimals) *
    BigInt(10) ** BigInt(PRICE_SCALE);
  // Divide by 100 to undo the cents scaling. Round up so the user always pays
  // at least the target — a rounding-down dust gap could fail verification.
  const denominator = priceScaled * BigInt(100);
  const amountBaseUnits =
    (numerator + denominator - BigInt(1)) / denominator;

  if (amountBaseUnits <= BigInt(0)) {
    throw new Error('quote produced a non-positive amount');
  }

  // Human display: amountBaseUnits / 10^decimals, trimmed to 4 dp.
  const whole = amountBaseUnits / BigInt(10) ** BigInt(decimals);
  const frac = amountBaseUnits % BigInt(10) ** BigInt(decimals);
  const fracStr = frac
    .toString()
    .padStart(decimals, '0')
    .slice(0, 4)
    .replace(/0+$/, '');
  const amountZer0 = fracStr ? `${whole}.${fracStr}` : whole.toString();

  return { amountBaseUnits, amountZer0, priceUsd, priceUsdTarget };
}
