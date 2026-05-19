// Long-running Telegram bot — runs on the Oracle Cloud VM (or wherever
// you have an always-on process). grammY does its own long-poll loop with
// reconnect-on-failure, so we just register handlers, wire the outbound
// listener, and start it.
//
// Env required at runtime:
//   TELEGRAM_BOT_TOKEN
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY  (createAdminClient)
//   GROQ_API_KEY                                     (used by chat-respond)
//   INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY           (inngest.send)

// Env is loaded by the runner — PM2's `env_file` directive (see
// ecosystem.config.cjs) or `node --env-file=.env.local` for local runs. We
// don't depend on dotenv to keep the dep tree thin.
import { Bot } from 'grammy';
import { env } from '../lib/env';
import { registerHandlers } from './handlers';
import { startOutboundListener } from './outbound';

async function main(): Promise<void> {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  registerHandlers(bot);

  // Global error handler — grammY would otherwise crash on an uncaught
  // handler exception, killing the long-poll loop.
  bot.catch((err) => {
    console.error('[telegram-bot] bot.catch', err);
  });

  const outbound = startOutboundListener(bot);

  const shutdown = async (signal: string) => {
    console.log(`[telegram-bot] received ${signal}, shutting down`);
    try {
      await bot.stop();
    } catch (err) {
      console.error('[telegram-bot] bot.stop failed', err);
    }
    try {
      await outbound.stop();
    } catch (err) {
      console.error('[telegram-bot] outbound.stop failed', err);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // bot.start() runs forever — log once we've established the loop. grammY
  // emits the ready event via `onStart` in the start config.
  console.log('[telegram-bot] starting long-poll loop...');
  await bot.start({
    onStart: (info) => {
      console.log(
        `[telegram-bot] Bot started, polling Telegram as @${info.username} (id=${info.id})`,
      );
    },
  });
}

main().catch((err) => {
  console.error('[telegram-bot] fatal', err);
  process.exit(1);
});
