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
import { assertCanTrade, startGeoblockWatcher } from './polymarket/preflight-geoblock';
import { attachSessionEventHandlers, getSignClient } from './wc/sign-client';
import { startExpiryCron } from './expiry-cron';
import { deleteWcSessionByTopic } from './db/sessions';
import { createAdminClient } from '../lib/supabase/admin';

async function main(): Promise<void> {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Geoblock pre-flight: refuse to register trade handlers if the bot's
  // egress IP is geoblocked. Close-only regions pass here but get
  // filtered later (per-order) — see §E2 / Caveats in the spec.
  let preflight;
  try {
    preflight = await assertCanTrade();
    console.log(
      `[telegram-bot] geoblock preflight OK — egress ${preflight.status.ip} (${preflight.status.country})` +
        (preflight.canOpenPositions ? '' : ' [close-only]'),
    );
  } catch (err) {
    console.error('[telegram-bot] geoblock preflight FAILED', err);
    process.exit(1);
  }

  // Boot WalletConnect SignClient ONCE (must not be re-init'd per-message;
  // doing so triggers the canonical resetPingTimeout crash). Subscribe to
  // session lifecycle events so we can clean up on revoke / expire.
  try {
    await getSignClient();
    await attachSessionEventHandlers({
      onSessionDelete: async (topic) => {
        try {
          await deleteWcSessionByTopic(createAdminClient(), topic);
        } catch (err) {
          console.error('[telegram-bot] cleanup on session_delete failed', err);
        }
      },
      onSessionExpire: async (topic) => {
        try {
          await deleteWcSessionByTopic(createAdminClient(), topic);
        } catch (err) {
          console.error('[telegram-bot] cleanup on session_expire failed', err);
        }
      },
    });
    console.log('[telegram-bot] WalletConnect SignClient ready');
  } catch (err) {
    console.error('[telegram-bot] SignClient init failed', err);
    process.exit(1);
  }

  registerHandlers(bot);

  // Global error handler — grammY would otherwise crash on an uncaught
  // handler exception, killing the long-poll loop.
  bot.catch((err) => {
    console.error('[telegram-bot] bot.catch', err);
  });

  const outbound = startOutboundListener(bot);
  const expiry = startExpiryCron(bot);
  const geoWatcher = startGeoblockWatcher({
    initial: preflight,
    onChange: (next) => {
      console.warn(
        '[telegram-bot] geoblock status changed',
        next.status,
        'canOpen=',
        next.canOpenPositions,
      );
    },
  });

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
    try {
      expiry.stop();
      geoWatcher.stop();
    } catch (err) {
      console.error('[telegram-bot] background stop failed', err);
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
