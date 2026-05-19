// PM2 process file for the Telegram long-poll bot. Run with:
//   pm2 start ecosystem.config.cjs --only zer0-telegram-bot
//   pm2 save
//
// Logs:   pm2 logs zer0-telegram-bot
// Stop:   pm2 stop zer0-telegram-bot
// Restart on reboot: `pm2 startup` then follow the printed instructions.

module.exports = {
  apps: [
    {
      name: 'zer0-telegram-bot',
      // `tsx` (devDependency) compiles+runs TS in one step. We pass
      // --env-file so the bot picks up TELEGRAM_BOT_TOKEN, SUPABASE_*,
      // GROQ_API_KEY, INNGEST_* from .env.local without dotenv.
      script: './node_modules/.bin/tsx',
      args: '--env-file=.env.local src/telegram-bot/index.ts',
      cwd: __dirname,
      // tsx is a shell wrapper, not a JS file — PM2 would otherwise try to
      // exec it under node and fail with a SyntaxError on the shebang.
      interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'zer0-inngest-dev',
      script: 'pnpm',
      args: 'dlx inngest-cli@latest dev -u http://localhost:3000/api/inngest',
      cwd: __dirname,
      interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',
      watch: false,
      env: { NODE_ENV: 'development' },
    },
  ],
};
