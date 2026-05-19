import type { Bot, Context } from 'grammy';
import { createAdminClient } from '../lib/supabase/admin';
import { checkRateLimit } from '../lib/chat/rate-limit';
import { inngest, chatMessageReceived } from '../lib/inngest/client';
import {
  consumeLinkCode,
  getOrCreateTelegramSession,
  upsertTelegramUser,
} from './db';

const WELCOME =
  "Hey, ZER0 here. I scan Polymarket all day looking for prediction markets " +
  "where the price doesn't match the evidence. Ask me what I'm watching, " +
  'what I\'d trade, or what I think about a specific market.\n\n' +
  'To link this chat to your web session, send /link followed by the code ' +
  'from app.atzer0.xyz.';

const HELP =
  "Commands:\n" +
  '/start — say hi, learn what I do\n' +
  '/help — this message\n' +
  '/link <code> — bind this Telegram chat to your web session so memory ' +
  'merges across both surfaces\n\n' +
  "Or just send a regular message and I'll respond with what I'm watching " +
  'on Polymarket. I don\'t custody funds — every trade is signed from your ' +
  'own wallet on the web app.';

const PAYWALL_MESSAGE =
  "You've hit today's chat limit. Paywall coming soon — for now, try again tomorrow.";

export function registerHandlers(bot: Bot): void {
  bot.command('start', async (ctx) => {
    try {
      await ctx.reply(WELCOME);
    } catch (err) {
      console.error('[telegram-bot] /start failed', err);
    }
  });

  bot.command('help', async (ctx) => {
    try {
      await ctx.reply(HELP);
    } catch (err) {
      console.error('[telegram-bot] /help failed', err);
    }
  });

  bot.command('link', async (ctx) => {
    try {
      const code = (ctx.match ?? '').toString().trim();
      if (!code) {
        await ctx.reply('Usage: /link <code> — paste the code from the web app.');
        return;
      }
      if (!ctx.from) {
        await ctx.reply("Couldn't identify you on Telegram's side. Try again.");
        return;
      }
      const supabase = createAdminClient();
      const userId = await upsertTelegramUser(
        supabase,
        ctx.from.id,
        ctx.from.first_name ?? null,
      );
      const result = await consumeLinkCode(supabase, code, userId);
      if (result.ok) {
        await ctx.reply('Linked — your web and Telegram chats now share memory.');
      } else {
        const msg =
          result.reason === 'expired'
            ? "That code expired. Generate a fresh one on the web app."
            : result.reason === 'already_used'
              ? 'That code was already used. Generate a new one if you need to re-link.'
              : result.reason === 'no_user'
                ? "That code isn't tied to a web account. Make sure you're signed in on the web app first."
                : "I couldn't find that code. Double-check it and try again.";
        await ctx.reply(msg);
      }
    } catch (err) {
      console.error('[telegram-bot] /link failed', err);
      try {
        await ctx.reply("Something went wrong linking that code. Try again in a minute.");
      } catch {
        /* swallow */
      }
    }
  });

  // Anything that isn't a command lands here. Commands are dispatched above
  // before this fires.
  bot.on('message:text', (ctx) => handleTextMessage(ctx));
}

async function handleTextMessage(ctx: Context): Promise<void> {
  try {
    if (!ctx.from || !ctx.chat || !ctx.message?.text) return;
    // grammY routes commands through bot.command(), but a bare message
    // starting with `/` we don't recognise should not be sent to Groq.
    if (ctx.message.text.startsWith('/')) {
      await ctx.reply("I don't know that command. Try /help.");
      return;
    }

    const supabase = createAdminClient();
    const userId = await upsertTelegramUser(
      supabase,
      ctx.from.id,
      ctx.from.first_name ?? null,
    );
    const sessionId = await getOrCreateTelegramSession(supabase, userId);

    // Per spec: telegram users are never anonymous from our perspective. Key
    // the rate-limit row by `tg:<userId>` so it can't collide with web
    // sha256-hex fingerprints.
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
      content: ctx.message.text,
    });

    // Best-effort typing indicator so the user sees the bot is working. Fail
    // open — if Telegram is unhappy we'd rather still produce a response.
    try {
      await ctx.replyWithChatAction('typing');
    } catch (err) {
      console.error('[telegram-bot] chat action failed', err);
    }

    await inngest.send(
      chatMessageReceived.create({
        sessionId,
        userId,
        channel: 'telegram',
        telegramChatId: ctx.chat.id,
      }),
    );
  } catch (err) {
    console.error('[telegram-bot] message:text failed', err);
    try {
      await ctx.reply(
        "Something on my side broke. Try again in a minute — I should be back online.",
      );
    } catch {
      /* swallow */
    }
  }
}
