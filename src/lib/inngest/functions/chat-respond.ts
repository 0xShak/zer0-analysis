import { inngest, chatMessageReceived } from '../client';
import { createAdminClient } from '../../supabase/admin';
import { getGroq, GROQ_MODELS } from '../../groq';
import { logUsage } from '../../cost/log';
import { computeCost } from '../../cost/openai-pricing';
import {
  CHAT_GROUND_RULES,
  formatRecentWorkForSystem,
  formatTradesForSystem,
  loadChatContext,
} from '../../chat/context';

// Triggered by the Telegram bot (and any other non-streaming caller). The web
// /api/chat route streams Groq directly, so it does NOT enqueue this event.
//
// Flow: load context (last 20 msgs + open trades + persona) → call Groq →
// persist assistant message → queue an outbound row for the channel adapter
// (the Telegram bot's outbound listener) → log cost.
export const chatRespond = inngest.createFunction(
  {
    id: 'zer0-chat-respond',
    name: 'ZER0 chat respond',
    triggers: [chatMessageReceived],
  },
  async ({ event, step }) => {
    const { sessionId, userId, channel, telegramChatId } = event.data as {
      sessionId: string;
      userId: string | null;
      channel: 'web' | 'telegram';
      telegramChatId?: number | null;
    };
    const supabase = createAdminClient();

    const context = await step.run('load-context', async () => {
      return loadChatContext(supabase, sessionId, userId);
    });

    const result = await step.run('groq-completion', async () => {
      const groq = getGroq();
      const system = `${context.persona}

## What you've been doing
${formatRecentWorkForSystem(context.recentMarkets, context.recentThoughts)}

Active trade recommendations:
${formatTradesForSystem(context.trades)}

${CHAT_GROUND_RULES}

Recent conversation memory follows. Respond as ZER0 — knowledgeable about Polymarket, has personality, doesn't hedge, references specific markets when relevant.`;

      try {
        const resp = await groq.chat.completions.create({
          model: GROQ_MODELS.CHAT,
          temperature: 0.4,
          // 800 (was 1500): the reply counts against Groq's free-tier per-minute
          // token ceiling; a chat answer rarely needs more, and the smaller cap
          // lets more messages land within the same minute. See groq.ts.
          max_tokens: 800,
          messages: [
            { role: 'system', content: system },
            ...context.messages.map((m) => ({
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content,
            })),
          ],
        });
        const tokens_in = resp.usage?.prompt_tokens ?? 0;
        const tokens_out = resp.usage?.completion_tokens ?? 0;
        await logUsage({
          provider: 'groq',
          model: GROQ_MODELS.CHAT,
          tokens_in,
          tokens_out,
          cost_usd: computeCost(GROQ_MODELS.CHAT, { tokens_in, tokens_out }),
          step: 'chat',
        });
        return { reply: resp.choices[0]?.message?.content ?? '', degraded: false };
      } catch (err) {
        // Groq rate-limited (429) or otherwise unavailable. Do NOT rethrow:
        // throwing fails the step, Inngest retries it ~4x over several minutes
        // (still rate-limited each time), and the user is left on "Typing…"
        // with no reply ever delivered. Instead deliver a short fallback so the
        // bot always answers. This mirrors brain-tick's summarize fallback.
        const status = (err as { status?: number } | null)?.status;
        console.warn(
          `[chat-respond] groq-completion failed (status=${status ?? 'n/a'}), delivering fallback`,
          err,
        );
        const reply =
          status === 429
            ? "I'm getting flooded with messages right now and hit my rate limit — give me a minute and ping me again."
            : 'Something glitched on my end just now — try me again in a sec.';
        return { reply, degraded: true };
      }
    });

    await step.run('persist-and-deliver', async () => {
      // Only persist genuine replies to message history. A degraded fallback is
      // still delivered to the channel, but kept out of `messages` so the canned
      // "rate limited" line doesn't get fed back into the next prompt's history.
      if (!result.degraded) {
        await supabase.from('messages').insert({
          session_id: sessionId,
          user_id: userId,
          role: 'assistant',
          channel,
          content: result.reply,
        });
      }
      if (channel !== 'web') {
        // The Telegram outbound listener watches this table over Supabase
        // Realtime. It needs the chat id from the original event — we never
        // store telegram_chat_id on the session row.
        await supabase.from('outbound_messages').insert({
          channel,
          session_id: sessionId,
          user_id: userId,
          telegram_chat_id: telegramChatId ?? null,
          content: result.reply,
        });
      }
    });

    return { ok: true };
  },
);
