# Multi-stage Docker build for the Telegram bot. Compile TS in the builder,
# carry only the JS + production node_modules into the runner.
#
# Build context is the repo root, not src/telegram-bot/, so paths below are
# relative to /root/zer0-backend.
#
#   docker build -f src/telegram-bot/Dockerfile -t zer0-telegram-bot .
#   docker run --env-file .env.local --name zer0-bot --restart=always zer0-telegram-bot

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# tsc emits the bot's JS into dist/. Keep --noEmit off and limit scope to
# what the bot actually needs (the typecheck CI step already covers the
# wider project).
RUN pnpm exec tsc \
      --outDir dist \
      --module nodenext \
      --target es2022 \
      --moduleResolution nodenext \
      --resolveJsonModule \
      --esModuleInterop \
      --skipLibCheck \
      --strict false \
      src/telegram-bot/index.ts

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist
COPY ZER0.md ./ZER0.md
CMD ["node", "dist/telegram-bot/index.js"]
