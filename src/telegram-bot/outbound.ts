import type { Bot } from 'grammy';
import { GrammyError, HttpError } from 'grammy';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../lib/database.types';
import { createAdminClient } from '../lib/supabase/admin';
import { CHAT_FALLBACK_MESSAGE } from '../lib/inngest/functions/chat-respond';

type OutboundRow = Database['public']['Tables']['outbound_messages']['Row'];
type AdminClient = SupabaseClient<Database>;

// Subscribe to outbound_messages INSERTs and forward each one to Telegram.
// Also replays anything stuck in the queue at boot (last 5 minutes), so a
// bot restart doesn't drop messages that chat-respond produced while we
// were down.
//
// We deliberately use `delivered_at` (already on the table from migration
// 0001) rather than introducing a parallel `sent_at` column — same semantics.
export function startOutboundListener(bot: Bot): { stop: () => Promise<void> } {
  const supabase = createAdminClient();

  // Replay pending rows from the last 5 minutes.
  void (async () => {
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('outbound_messages')
        .select('id, channel, telegram_chat_id, content, delivered_at, created_at')
        .eq('channel', 'telegram')
        .is('delivered_at', null)
        .gt('created_at', fiveMinAgo)
        .order('created_at', { ascending: true });
      if (error) throw error;
      for (const row of data ?? []) {
        await deliver(bot, row as OutboundRow);
      }
    } catch (err) {
      console.error('[telegram-bot] startup replay failed', err);
    }
  })();

  // Live subscription: every INSERT with channel='telegram' fires.
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
        const row = payload.new as OutboundRow;
        // Don't await — we don't want to block the realtime callback. Errors
        // are swallowed inside deliver().
        void deliver(bot, row);
      },
    )
    .subscribe((status) => {
      console.log('[telegram-bot] outbound channel status:', status);
    });

  return {
    stop: async () => {
      await supabase.removeChannel(channel);
    },
  };
}

// Exported (and the supabase client is injectable) so the empty-text guard
// can be unit-tested without a real admin client. Production callers omit
// `supabase` and get the lazily-created admin client.
export async function deliver(
  bot: Bot,
  row: OutboundRow,
  supabase: AdminClient = createAdminClient(),
): Promise<void> {
  if (!row.telegram_chat_id) {
    console.error('[telegram-bot] outbound row missing telegram_chat_id', {
      id: row.id,
    });
    return;
  }
  // Never call sendMessage with empty text — Telegram rejects it with 400
  // "message text is empty", which deliver()'s catch swallows as
  // "delivered", producing another silent path. Substitute the fallback so
  // the user always sees something. See #2 in chat-stuck-typing.md.
  const text = row.content.trim() === '' ? CHAT_FALLBACK_MESSAGE : row.content;
  try {
    // Send as plain text. The spec asks for Markdown but with the strict
    // caveat of escaping user content; ZER0 replies frequently include `$`
    // and dashes that MarkdownV2 considers reserved. Until we have a
    // hardened escape path, plain text is the safer default — Telegram still
    // renders fine and we avoid 400 BAD_REQUEST loops.
    await bot.api.sendMessage(Number(row.telegram_chat_id), text);

    await supabase
      .from('outbound_messages')
      .update({ delivered_at: new Date().toISOString() })
      .eq('id', row.id);
  } catch (err) {
    if (err instanceof GrammyError) {
      // 403 = blocked by user / kicked; 400 = chat not found; nothing we can
      // do — mark as delivered so we don't keep replaying.
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
  }
}
