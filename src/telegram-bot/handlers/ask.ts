// Free-text message router for the bot.
//
// Branches on the parsed intent:
//   open_trade  (conf >= 0.7)  → handleTradeIntent (trade.ts)
//   open_trade  (conf <  0.7)  → ask clarifying question, no trade prep
//   analyze_market / status / small_talk → fall through to existing
//     Inngest chat-respond pipeline (which already powers /chat-only DMs)
//
// We never let the LLM trigger a trade itself — see §F1. The branch into
// trade.ts is a pure structural switch on the parsed JSON, with no LLM
// tool surface anywhere.

import type { Context } from 'grammy';
import { createAdminClient } from '../../lib/supabase/admin';
import { checkRateLimit } from '../../lib/chat/rate-limit';
import { inngest, chatMessageReceived } from '../../lib/inngest/client';
import { CHAT_FALLBACK_MESSAGE } from '../../lib/inngest/functions/chat-respond';
import {
  getOrCreateTelegramSession,
  upsertTelegramUser,
} from '../db';
import { parseIntent, IntentParseError } from '../intent/parse';
import { allowChatMessage } from '../trade-rate-limit';
import { handleTradeIntent } from './trade';
import { handleSimIntent } from './sim';

const CONFIDENCE_THRESHOLD = 0.7;
const PAYWALL_MESSAGE =
  "You've hit today's chat limit. Try again tomorrow.";

export async function handleAskOrTrade(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat || !ctx.message?.text) return;
  const text = ctx.message.text;
  if (text.startsWith('/')) {
    await ctx.reply("I don't know that command. Try /help.");
    return;
  }

  // Apply tg-trade scope rate limit BEFORE any LLM call so a flood of
  // messages can't drain the Groq free-tier (and so an attacker can't
  // burn budget). See §F3.
  if (!allowChatMessage(ctx.from.id)) {
    await ctx.reply("Slow down — 50 messages/hour. Try again in a bit.");
    return;
  }

  const supabase = createAdminClient();
  const userId = await upsertTelegramUser(
    supabase,
    ctx.from.id,
    ctx.from.first_name ?? null,
  );
  const sessionId = await getOrCreateTelegramSession(supabase, userId);

  const rate = await checkRateLimit(supabase, `tg:${userId}`, userId);
  if (!rate.allowed) {
    await ctx.reply(PAYWALL_MESSAGE);
    return;
  }

  await supabase.from('messages').insert({
    session_id: sessionId,
    user_id: userId,
    role: 'user',
    channel: 'telegram',
    content: text,
  });

  try {
    await ctx.replyWithChatAction('typing');
  } catch (err) {
    console.error('[telegram-bot] chat action failed', err);
  }

  // Run the intent parse on every message. Cheap (8B free-tier), and a
  // valid open_trade intent supersedes the chat-respond pipeline.
  let intent;
  try {
    intent = await parseIntent({ userText: text });
  } catch (err) {
    // ANY parse failure degrades to intent=null and falls through to the chat
    // pipeline — never rethrow. IntentParseError means malformed classifier
    // output; anything else (e.g. a Groq 429 that even the overflow fallback
    // couldn't absorb) used to propagate to handleTextMessageSafe and DROP the
    // message with no reply. Losing the intent just skips trade/sim shortcut
    // detection; the user still gets a chat reply. See 429_op.md task 3.
    if (!(err instanceof IntentParseError)) {
      console.error('[telegram-bot] intent parse failed, treating as chat', err);
    }
    intent = null;
  }

  if (
    intent &&
    intent.intent === 'open_trade' &&
    intent.confidence >= CONFIDENCE_THRESHOLD
  ) {
    await handleTradeIntent(ctx, intent);
    return;
  }
  if (
    intent &&
    intent.intent === 'open_trade' &&
    intent.confidence < CONFIDENCE_THRESHOLD
  ) {
    await ctx.reply(
      "I think you want to trade but I'm not sure — could you spell it out? e.g. 'buy $5 of YES on the Bitcoin market'.",
    );
    return;
  }

  // Sim intent supersedes the chat pipeline, same structural switch as trades.
  if (
    intent &&
    intent.intent === 'run_sim' &&
    intent.confidence >= CONFIDENCE_THRESHOLD
  ) {
    await handleSimIntent(ctx, intent.scenario ?? text);
    return;
  }

  // Default — kick to the existing Inngest chat pipeline. The reply comes
  // back asynchronously over the outbound_messages realtime channel. If the
  // hand-off itself fails (rare — 3 times ever in prod), don't leave the user
  // on silent "Typing…": reply inline with the same fallback. See #4 in
  // chat-stuck-typing.md.
  //
  // Carry the market the user referenced so chat-respond can pull live
  // Polymarket data: prefer the intent parser's extracted market_query, fall
  // back to the raw message (chat-respond gates on token significance, so
  // small-talk no-ops).
  try {
    await inngest.send(
      chatMessageReceived.create({
        sessionId,
        userId,
        channel: 'telegram',
        telegramChatId: ctx.chat.id,
        marketQuery: intent?.market_query ?? text,
      }),
    );
  } catch (err) {
    console.error('[telegram-bot] inngest.send(chatMessageReceived) failed', err);
    await ctx.reply(CHAT_FALLBACK_MESSAGE);
  }
}
