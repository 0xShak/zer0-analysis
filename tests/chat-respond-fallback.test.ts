import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  CHAT_FALLBACK_MESSAGE,
  queueFallbackReply,
} from '@/lib/inngest/functions/chat-respond';
import { deliver } from '@/telegram-bot/outbound';

type OutboundRow = Database['public']['Tables']['outbound_messages']['Row'];

/**
 * A minimal Supabase admin-client stub that records every insert/update by
 * table. Only the surface chat-respond / outbound actually touch is modeled.
 */
function supabaseStub() {
  const inserts: Array<{ table: string; rows: unknown }> = [];
  const updates: Array<{ table: string; values: unknown }> = [];
  const client = {
    from(table: string) {
      return {
        insert(rows: unknown) {
          inserts.push({ table, rows });
          return Promise.resolve({ data: null, error: null });
        },
        update(values: unknown) {
          updates.push({ table, values });
          // .update().eq() chains, then awaits.
          return {
            eq: () => Promise.resolve({ data: null, error: null }),
          };
        },
      };
    },
  } as unknown as SupabaseClient<Database>;
  return { client, inserts, updates };
}

describe('chat-respond fallback (onFailure path)', () => {
  // Mirror what the onFailure handler does after groq-completion exhausts its
  // retries with a 429: it calls queueFallbackReply with the original event
  // data. We assert the canned fallback lands in both messages and
  // outbound_messages, routed to the original telegram chat.
  it('queues a fallback outbound row when Groq 429s out the run', async () => {
    // Simulate the groq-completion step blowing up with a 429 (the leading
    // root cause). groq-sdk RateLimitError carries `status: 429`.
    const groq429 = Object.assign(new Error('Rate limit reached'), {
      name: 'RateLimitError',
      status: 429,
    });
    const groqCompletion = vi.fn().mockRejectedValue(groq429);
    await expect(groqCompletion()).rejects.toMatchObject({ status: 429 });

    const { client, inserts } = supabaseStub();
    await queueFallbackReply(client, {
      sessionId: 'sess-1',
      userId: 'user-1',
      channel: 'telegram',
      telegramChatId: 4242,
    });

    const messageInsert = inserts.find((i) => i.table === 'messages');
    expect(messageInsert?.rows).toMatchObject({
      session_id: 'sess-1',
      role: 'assistant',
      channel: 'telegram',
      content: CHAT_FALLBACK_MESSAGE,
    });

    const outboundInsert = inserts.find((i) => i.table === 'outbound_messages');
    expect(outboundInsert?.rows).toMatchObject({
      channel: 'telegram',
      session_id: 'sess-1',
      telegram_chat_id: 4242,
      content: CHAT_FALLBACK_MESSAGE,
    });
  });

  it('does NOT queue an outbound row for the web channel (streamed elsewhere)', async () => {
    const { client, inserts } = supabaseStub();
    await queueFallbackReply(client, {
      sessionId: 'sess-web',
      userId: null,
      channel: 'web',
    });
    expect(inserts.some((i) => i.table === 'messages')).toBe(true);
    expect(inserts.some((i) => i.table === 'outbound_messages')).toBe(false);
  });
});

describe('outbound deliver() empty-text guard', () => {
  function botStub() {
    const sent: Array<{ chatId: number; text: string }> = [];
    const bot = {
      api: {
        sendMessage: vi.fn(async (chatId: number, text: string) => {
          sent.push({ chatId, text });
        }),
      },
    };
    return { bot, sent };
  }

  function row(content: string): OutboundRow {
    return {
      id: 1,
      channel: 'telegram',
      session_id: 'sess-1',
      user_id: 'user-1',
      telegram_chat_id: 4242,
      content,
      delivered_at: null,
      created_at: new Date().toISOString(),
    };
  }

  it('never calls sendMessage with empty text — substitutes the fallback', async () => {
    const { client } = supabaseStub();
    const { bot, sent } = botStub();

    await deliver(bot as never, row(''), client);
    await deliver(bot as never, row('   '), client);

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    for (const call of sent) {
      expect(call.text).not.toBe('');
      expect(call.text.trim()).not.toBe('');
      expect(call.text).toBe(CHAT_FALLBACK_MESSAGE);
    }
  });

  it('passes real content through unchanged', async () => {
    const { client } = supabaseStub();
    const { bot, sent } = botStub();

    await deliver(bot as never, row('BTC is heating up.'), client);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('BTC is heating up.');
  });
});
