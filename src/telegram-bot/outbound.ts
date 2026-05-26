import type { Bot } from 'grammy';
import { GrammyError, HttpError } from 'grammy';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../lib/database.types';
import { createAdminClient } from '../lib/supabase/admin';

type OutboundRow = Database['public']['Tables']['outbound_messages']['Row'];

// Deliver outbound chat replies to Telegram. chat-respond (the Inngest function
// on Vercel) generates the reply and inserts an `outbound_messages` row; this
// listener forwards it to the user.
//
// Delivery uses TWO mechanisms:
//   1. A polling sweep (every POLL_MS) over undelivered rows — the reliable
//      workhorse. It does NOT depend on the Realtime websocket, which we
//      observed silently stop delivering: replies piled up with
//      delivered_at=null for hours while the bot's Telegram long-poll kept
//      working (so /commands still replied but chat answers never arrived).
//      The sweep also drains any backlog left by downtime when the bot starts.
//   2. A Supabase Realtime subscription — a best-effort, low-latency fast-path.
//      If it drops, the sweep still delivers within POLL_MS.
//
// An in-process `inFlight` set stops the two paths from double-sending the same
// row; `delivered_at` is the durable guard — once set, the sweep's
// `is('delivered_at', null)` filter excludes the row.
export function startOutboundListener(bot: Bot): { stop: () => Promise<void> } {
  const supabase = createAdminClient();
  const inFlight = new Set<number>();
  const POLL_MS = 5_000;
  let stopped = false;

  async function sweep(): Promise<void> {
    if (stopped) return;
    try {
      // Oldest-first so a backlog drains in order; capped per pass so a large
      // backlog drains gradually instead of blocking the loop.
      const { data, error } = await supabase
        .from('outbound_messages')
        .select('id, channel, telegram_chat_id, content, delivered_at, created_at')
        .eq('channel', 'telegram')
        .is('delivered_at', null)
        .order('created_at', { ascending: true })
        .limit(50);
      if (error) throw error;
      for (const row of data ?? []) {
        await deliver(bot, supabase, row as OutboundRow, inFlight);
      }
    } catch (err) {
      console.error('[telegram-bot] outbound sweep failed', err);
    }
  }

  // Sweep once immediately (recovers any backlog at boot), then on interval.
  void sweep();
  const timer = setInterval(() => void sweep(), POLL_MS);

  // Realtime fast-path: every INSERT with channel='telegram' fires. Errors are
  // swallowed inside deliver(); the sweep is the safety net if this drops.
  const channel = supabase
    .channel('outbound:telegram')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'outbound_messages',
        filter: 'channel=eq.telegram',
      },
      (payload) => {
        // Don't await — we don't want to block the realtime callback.
        void deliver(bot, supabase, payload.new as OutboundRow, inFlight);
      },
    )
    .subscribe((status) => {
      console.log('[telegram-bot] outbound channel status:', status);
    });

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await supabase.removeChannel(channel);
    },
  };
}

async function deliver(
  bot: Bot,
  supabase: SupabaseClient<Database>,
  row: OutboundRow,
  inFlight: Set<number>,
): Promise<void> {
  if (!row.telegram_chat_id) {
    console.error('[telegram-bot] outbound row missing telegram_chat_id', {
      id: row.id,
    });
    return;
  }
  // Synchronous claim: no await between has() and add(), so the Realtime
  // callback and a concurrent sweep can't both enter delivery for the same id.
  if (inFlight.has(row.id)) return;
  inFlight.add(row.id);
  try {
    // Send as plain text. The spec asks for Markdown but with the strict
    // caveat of escaping user content; ZER0 replies frequently include `$`
    // and dashes that MarkdownV2 considers reserved. Until we have a hardened
    // escape path, plain text is the safer default — Telegram still renders
    // fine and we avoid 400 BAD_REQUEST loops.
    await bot.api.sendMessage(Number(row.telegram_chat_id), row.content);
    await supabase
      .from('outbound_messages')
      .update({ delivered_at: new Date().toISOString() })
      .eq('id', row.id);
  } catch (err) {
    if (err instanceof GrammyError) {
      // 403 = blocked by user / kicked; 400 = chat not found — permanent.
      // Mark delivered so the sweep stops retrying it forever.
      console.error('[telegram-bot] grammy error', err.error_code, err.description);
      if (err.error_code === 400 || err.error_code === 403) {
        await supabase
          .from('outbound_messages')
          .update({ delivered_at: new Date().toISOString() })
          .eq('id', row.id);
      }
    } else if (err instanceof HttpError) {
      console.error('[telegram-bot] telegram http error', err);
    } else {
      console.error('[telegram-bot] deliver failed', err);
    }
    // Transient errors leave delivered_at null → the next sweep retries.
  } finally {
    // Release the claim. Success/permanent-failure already set delivered_at,
    // so the sweep's null filter won't re-select the row; transient failures
    // are intentionally left for the next sweep to retry.
    inFlight.delete(row.id);
  }
}
