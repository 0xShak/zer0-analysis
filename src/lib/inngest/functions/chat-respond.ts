import type { SupabaseClient } from '@supabase/supabase-js';
import { inngest, chatMessageReceived } from '../client';
import { createAdminClient } from '../../supabase/admin';
import type { Database } from '../../database.types';
import { getGroq, GROQ_MODELS } from '../../groq';
import { logUsage } from '../../cost/log';
import { computeCost } from '../../cost/openai-pricing';
import {
  CHAT_GROUND_RULES,
  formatRecentWorkForSystem,
  formatTradesForSystem,
  loadChatContext,
} from '../../chat/context';

// Shown to the user whenever we can't produce a real reply — either Groq
// returned empty content, or the function exhausted its retries and hit the
// onFailure path. The whole point is that the bot is NEVER silent: the user
// always gets either a real answer or this.
export const CHAT_FALLBACK_MESSAGE =
  "I had trouble with that one — try again in a sec.";

type AdminClient = SupabaseClient<Database>;

// The slice of the triggering event we need to route a reply back to the
// right session/channel. Used by both the happy path and the failure path.
type ChatEventData = {
  sessionId: string;
  userId: string | null;
  channel: 'web' | 'telegram';
  telegramChatId?: number | null;
};

// Persist an assistant message and (for non-web channels) an outbound row the
// Telegram listener will pick up. Extracted + dependency-injectable so the
// failure path and unit tests can drive it without an Inngest runtime.
async function persistAssistantReply(
  supabase: AdminClient,
  { sessionId, userId, channel, telegramChatId }: ChatEventData,
  content: string,
): Promise<void> {
  await supabase.from('messages').insert({
    session_id: sessionId,
    user_id: userId,
    role: 'assistant',
    channel,
    content,
  });
  if (channel !== 'web') {
    // The Telegram outbound listener watches this table over Supabase
    // Realtime. It needs the chat id from the original event — we never
    // store telegram_chat_id on the session row.
    await supabase.from('outbound_messages').insert({
      channel,
      session_id: sessionId,
      user_id: userId,
      telegram_chat_id: telegramChatId ?? null,
      content,
    });
  }
}

// Terminal-failure fallback: queue the canned fallback so the user always gets
// a reply even when groq-completion (or load-context) dies. Injectable for
// tests; the onFailure handler wires it to a real admin client.
export async function queueFallbackReply(
  supabase: AdminClient,
  data: ChatEventData,
): Promise<void> {
  await persistAssistantReply(supabase, data, CHAT_FALLBACK_MESSAGE);
}

// Triggered by the Telegram bot (and any other non-streaming caller). The web
// /api/chat route streams Groq directly, so it does NOT enqueue this event.
//
// Flow: load context (last 20 msgs + open trades + persona) → call Groq →
// persist assistant message → queue an outbound row for the channel adapter
// (the Telegram bot's outbound listener) → log cost.
//
// onFailure: if the run exhausts its retries (most likely a Groq 429 from
// free-tier contention with brain-tick), we still queue a fallback outbound
// row so the user is never left on silent "Typing…". See chat-stuck-typing.md.
export const chatRespond = inngest.createFunction(
  {
    id: 'zer0-chat-respond',
    name: 'ZER0 chat respond',
    triggers: [chatMessageReceived],
    onFailure: async ({ event, error, step }) => {
      // The original triggering event is nested under the failure payload.
      const data = event.data.event.data as ChatEventData;
      console.error('[chat-respond] terminal failure, queueing fallback', {
        sessionId: data.sessionId,
        channel: data.channel,
        errorName: error?.name,
        errorMessage: error?.message,
      });
      await step.run('queue-fallback', async () => {
        const supabase = createAdminClient();
        await queueFallbackReply(supabase, data);
      });
    },
  },
  async ({ event, step }) => {
    const { sessionId, userId, channel, telegramChatId } =
      event.data as ChatEventData;
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

      // Instrumentation: the next time this throws (429 vs 15s timeout vs
      // content filter), the model/latency/finish_reason/error are in the
      // Vercel logs so it's diagnosable without re-deriving. See #6 in
      // chat-stuck-typing.md.
      const startedAt = Date.now();
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
        const finishReason = resp.choices[0]?.finish_reason;
        console.info('[chat-respond] groq-completion ok', {
          model: GROQ_MODELS.CHAT,
          latencyMs: Date.now() - startedAt,
          finishReason,
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
        // groq-sdk APIError exposes `.status` (e.g. 429); plain errors don't.
        const status = (err as { status?: number } | null)?.status;
        console.warn('[chat-respond] groq-completion failed, delivering fallback', {
          model: GROQ_MODELS.CHAT,
          latencyMs: Date.now() - startedAt,
          errorName: (err as Error)?.name,
          errorStatus: status,
        });
        const reply =
          status === 429
            ? "I'm getting flooded with messages right now and hit my rate limit — give me a minute and ping me again."
            : 'Something glitched on my end just now — try me again in a sec.';
        return { reply, degraded: true };
      }
    });

    await step.run('persist-and-deliver', async () => {
      // Guard empty content: Groq can return '' (e.g. finish_reason
      // content_filter). Persisting/sending '' would make the Telegram outbound
      // path call sendMessage('') → 400 → another silent failure. Substitute the
      // fallback instead. See #2 in chat-stuck-typing.md.
      const isEmpty = result.reply.trim() === '';
      const content = isEmpty ? CHAT_FALLBACK_MESSAGE : result.reply;

      // Only persist genuine replies to message history. A degraded fallback (or
      // a substituted empty reply) is still delivered to the channel, but kept
      // out of `messages` so the canned line doesn't get fed back into the next
      // prompt's history.
      if (!result.degraded && !isEmpty) {
        await supabase.from('messages').insert({
          session_id: sessionId,
          user_id: userId,
          role: 'assistant',
          channel,
          content,
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
          content,
        });
      }
    });

    return { ok: true };
  },
);
