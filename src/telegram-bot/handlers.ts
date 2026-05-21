import type { Bot, Context } from 'grammy';
import { createAdminClient } from '../lib/supabase/admin';
import {
  consumeLinkCode,
  upsertTelegramUser,
} from './db';
import { handleConnect } from './handlers/connect';
import { handleAskOrTrade } from './handlers/ask';
import { handleTradeCallback } from './handlers/confirm';

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

  // /connect — pair a wallet over WalletConnect v2.
  bot.command('connect', async (ctx) => {
    try {
      await handleConnect(ctx);
    } catch (err) {
      console.error('[telegram-bot] /connect failed', err);
    }
  });

  // Inline-keyboard taps from a trade echo.
  bot.callbackQuery(/^trade:(confirm|cancel):[0-9a-f-]{36}$/, async (ctx) => {
    try {
      await handleTradeCallback(ctx);
    } catch (err) {
      console.error('[telegram-bot] trade callback failed', err);
      try {
        await ctx.answerCallbackQuery({ text: 'Something broke.' });
      } catch {
        /* swallow */
      }
    }
  });

  // Bare text — route through intent parser → trade.ts or fall through
  // to the existing Inngest chat pipeline.
  bot.on('message:text', (ctx) => handleTextMessageSafe(ctx));
}

async function handleTextMessageSafe(ctx: Context): Promise<void> {
  try {
    await handleAskOrTrade(ctx);
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
