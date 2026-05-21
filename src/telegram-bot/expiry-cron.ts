// Restart-safe expiry cron for tg_pending_trades.
//
// Every 30 seconds we transition any AWAITING_USER_CONFIRM row whose
// expires_at has passed → EXPIRED. The state machine lives in Postgres so
// a bot restart doesn't lose the timer — but we still need a watcher to
// transition rows whose human user simply walked away.
//
// We notify the user once per expired row by editing the original
// inline-keyboard message to "expired" (best-effort: if Telegram refuses
// the edit, we just log and move on — the DB state is the source of
// truth).

import type { Bot } from 'grammy';
import { createAdminClient } from '../lib/supabase/admin';
import { expireStalePendingTrades, getPendingTrade } from './db/pending-trades';

const TICK_MS = 30_000;

export function startExpiryCron(bot: Bot): { stop: () => void } {
  const handle = setInterval(() => {
    void tick(bot);
  }, TICK_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return { stop: () => clearInterval(handle) };
}

async function tick(bot: Bot): Promise<void> {
  try {
    const supabase = createAdminClient();
    const expiredIds = await expireStalePendingTrades(supabase);
    if (expiredIds.length === 0) return;
    for (const id of expiredIds) {
      try {
        const row = await getPendingTrade(supabase, id);
        if (!row || row.messageId == null) continue;
        await bot.api.editMessageText(
          row.chatId,
          row.messageId,
          'That trade prompt timed out (90s). Tell me what you want to do.',
        );
      } catch (err) {
        // Telegram sometimes refuses edits on old messages — non-fatal.
        console.warn('[expiry-cron] message edit failed', id, err);
      }
    }
  } catch (err) {
    console.error('[expiry-cron] tick failed', err);
  }
}
