// Per-Telegram-user trade rate-limit. Keyed under the 'tg-trade' scope so
// it can't collide with the existing /api/trade/* in-memory limiter.
//
// Single-process in-memory limiter (the bot's PM2 process is the only
// caller). When/if the bot is replicated, swap for Postgres or Redis.

import { rateLimit, rateLimitKey } from '../lib/trades/rate-limit';

const TRADES_PER_DAY = 10;
const MESSAGES_PER_HOUR = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function allowTradeAttempt(telegramUserId: number): boolean {
  return rateLimit(
    rateLimitKey(['tg-trade', String(telegramUserId), 'day']),
    TRADES_PER_DAY,
    DAY_MS,
  );
}

export function allowChatMessage(telegramUserId: number): boolean {
  return rateLimit(
    rateLimitKey(['tg-trade', String(telegramUserId), 'hour']),
    MESSAGES_PER_HOUR,
    HOUR_MS,
  );
}
