// Pre-signature bounds-checks. These run AFTER the LLM intent parse and
// BEFORE we ever ask the wallet to sign — a fully jailbroken parser cannot
// produce an out-of-bounds order.

import type { Intent } from './intent/parse';

export interface BoundsArgs {
  intent: Intent;
  /** Live book midpoint, for slippage check. */
  midpoint: number | null;
  /** Live book best price for our side (used as the executable price). */
  executionPrice: number;
  /** Min order size in shares, from getClobMarketInfo / order-book. */
  minOrderSize: number;
}

export type BoundsResult =
  | { ok: true }
  | { ok: false; reason: string };

const MIN_USD = 0.5;
const MAX_USD = 200;
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;
const MAX_SLIPPAGE = 0.1; // 10%

export function enforceBounds(args: BoundsArgs): BoundsResult {
  const { intent, midpoint, executionPrice, minOrderSize } = args;

  if (intent.intent !== 'open_trade' && intent.intent !== 'close_trade') {
    return { ok: false, reason: 'not_tradable_intent' };
  }
  if (intent.size_kind !== 'usd' || intent.size_value == null) {
    return { ok: false, reason: 'size_must_be_usd' };
  }
  const usd = intent.size_value;
  if (intent.side === 'BUY') {
    if (usd < MIN_USD)
      return { ok: false, reason: `min_buy_usd:${MIN_USD}` };
    if (usd > MAX_USD)
      return { ok: false, reason: `max_buy_usd:${MAX_USD}` };
  }
  if (executionPrice < MIN_PRICE || executionPrice > MAX_PRICE) {
    return { ok: false, reason: `price_out_of_bounds:${executionPrice}` };
  }
  if (midpoint && midpoint > 0) {
    const slip = Math.abs(executionPrice - midpoint) / midpoint;
    if (slip > MAX_SLIPPAGE)
      return { ok: false, reason: `slippage_exceeds_${MAX_SLIPPAGE}` };
  }
  // Shares derived from USD at the execution price; refuse if it would
  // round below the market's per-order minimum (refused server-side
  // anyway, but catching here gives a clean Telegram error).
  const shares = usd / executionPrice;
  if (minOrderSize > 0 && shares < minOrderSize) {
    return { ok: false, reason: `below_min_size:${minOrderSize}` };
  }
  return { ok: true };
}
