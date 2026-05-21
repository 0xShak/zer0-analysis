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
import {
  getOrCreateTelegramSession,
  upsertTelegramUser,
} from '../db';
import { parseIntent, IntentParseError } from '../intent/parse';
import { allowChatMessage } from '../trade-rate-limit';
import { handleTradeIntent } from './trade';

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
    if (err instanceof IntentParseError) {
      // Couldn't make sense of the message via the classifier — fall through
      // to the chat pipeline rather than telling the user we failed.
      intent = null;
    } else {
      throw err;
    }
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

  // Default — kick to the existing Inngest chat pipeline.
  await inngest.send(
    chatMessageReceived.create({
      sessionId,
      userId,
      channel: 'telegram',
      telegramChatId: ctx.chat.id,
    }),
  );
}
