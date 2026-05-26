# ZER0 — backend

Autonomous AI agent that watches Polymarket for trades with deterministic
outcomes. The source of truth for architecture is [`zer0.md`](./zer0.md);
this README is just the dev quickstart.

## What's in here

- **Next.js 16 app** (App Router, TypeScript, Tailwind v4) — UI + API routes.
- **Inngest functions** (`src/lib/inngest/functions/`) — the brain tick cron
  and the chat-respond event handler. Mounted at `/api/inngest`.
- **Supabase migration** (`supabase/migrations/0001_initial.sql`) — full
  schema from zer0.md §5 with RLS policies and realtime publication.
- **Proxy** (`src/proxy.ts`, Next 16's replacement for middleware) — issues
  the `zer0_sid` cookie used by the fingerprint composite.

## What's NOT in here (yet)

- Always-on Oracle Cloud workers (Polymarket WS subscriber, Telegram bot) —
  separate Docker stack, see zer0.md §11 and §4.
- Real EIP-712 order build / submit — `src/lib/polymarket/clob.ts` is
  stubbed. Wire `@polymarket/clob-client` on Day 5 of zer0.md §13.

## Deviation from zer0.md

The deep-analyze step (Day 2 of §13) is implemented with **OpenAI
`gpt-5.5-pro` directly**, not Claude Agent SDK. Reasons: single-shot
structured-output call needs no agent loop, Anthropic billing was
unreliable for this account, and GPT-5.5 Pro's reasoning benchmarks suit
prediction-market forecasting. See `src/lib/agents/deep-analyzer.ts`.

Costs land in the new `public.agent_usage` table (migration 0002). The
brain-tick checks a daily budget cap (`ANALYZER_DAILY_BUDGET_USD`, default
$25) before running OpenAI calls and emits a `scope='app'` thought if it
short-circuits.

**Caveat:** `gpt-5.5-pro` does NOT offer a cached-input discount, so the
caching benefit only materialises if you point `ANALYZER_MODEL` at the
cheaper `gpt-5.5` slug.

## Setup

```bash
cp .env.example .env.local
# fill in: Supabase URL+keys, Groq, Anthropic, Coinbase, Inngest, etc.

# Apply the schema to your Supabase project:
supabase link --project-ref <ref>
supabase db push

# (optional) regenerate types from the live DB:
supabase gen types typescript --linked > src/lib/database.types.ts

pnpm dev
```

Then in a second terminal start the Inngest dev server so the brain tick
fires locally:

```bash
pnpm dlx inngest-cli@latest dev -u http://localhost:3000/api/inngest
```

## Routes

| Path                       | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `/`                        | Landing page with the public chain-of-thought stream     |
| `/app`                     | Chat + thoughts + open trade recommendations             |
| `/payment-success`         | Coinbase Commerce redirect                               |
| `/payment-cancelled`       | Coinbase Commerce cancel                                 |
| `POST /api/chat`           | Streamed Groq chat with persona + memory + trade context |
| `POST /api/checkout`       | Create a Coinbase Commerce charge                        |
| `POST /api/coinbase-webhook` | Verify HMAC, flip the entitlements row                 |
| `POST /api/trade/prepare`  | Return unsigned EIP-712 order payload                    |
| `POST /api/trade/submit`   | Forward user-signed order to the CLOB                    |
| `GET/POST/PUT /api/inngest`| Inngest function endpoint                                |

## Telegram bot

Long-running grammY long-poll process. Lives outside Vercel (serverless can't
hold the poll loop). Bot code is at `src/telegram-bot/`; entry point
`src/telegram-bot/index.ts`.

**Env vars**

- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather) (`/newbot`).
- `TELEGRAM_BOT_USERNAME` — optional, only used in logs/docs (the bot reads
  the username from the Telegram API on startup).
- Plus the usual `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
  `GROQ_API_KEY`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`.

**Run with PM2** (preferred)

```bash
pm2 start ecosystem.config.cjs --only zer0-telegram-bot
pm2 save                 # persist across reboot (run `pm2 startup` once)
pm2 logs zer0-telegram-bot
pm2 stop zer0-telegram-bot
```

The PM2 config invokes `tsx --env-file=.env.local src/telegram-bot/index.ts`
with `autorestart: true` and `max_restarts: 10` within `60s`.

**Run with Docker** (alternative)

```bash
docker build -f src/telegram-bot/Dockerfile -t zer0-telegram-bot .
docker run --env-file .env.local --restart=always --name zer0-bot zer0-telegram-bot
```

**Local sanity check** (no auto-restart)

```bash
pnpm exec tsx --env-file=.env.local src/telegram-bot/index.ts
```

**Commands the bot handles**

| Command            | Behaviour                                                            |
| ------------------ | -------------------------------------------------------------------- |
| `/start`           | Persona-aligned welcome message.                                     |
| `/help`            | List commands + short description of what ZER0 does.                 |
| `/link <code>`     | Bind this Telegram user to an existing web session (see below).      |
| any other text     | Routes through Inngest `chat/message.received` → `chat-respond`.     |

**Cross-channel linking**

`/link <code>` consumes a single-use code from the `link_codes` table
(migration 0003). On success: the telegram user is merged into the web user
(sessions/messages re-parented, telegram_user_id moved over) and the code is
marked `consumed_at`. Codes expire after 15 minutes by default. The web-side
endpoint that *issues* codes is out of scope until a later day.

**Architecture note**

The bot does NOT call Groq itself. It writes the inbound user message to
`messages` and triggers an Inngest `chat/message.received` event. The
`chat-respond` Inngest function (`src/lib/inngest/functions/chat-respond.ts`)
runs the Groq call and inserts an `outbound_messages` row with
`channel='telegram'`. A Supabase Realtime listener inside the bot picks up
that row over `postgres_changes` and calls `bot.api.sendMessage`. On startup
the bot also replays any unsent rows from the last 5 minutes (`delivered_at
IS NULL`) so a restart doesn't drop messages.

### `POST /api/chat`

Web chat endpoint. Runs on the Node runtime; streams a Groq Llama 3.1 8B
response back as Server-Sent Events.

**Request body**

```json
{ "message": "string (1–2000 chars)", "session_id": "uuid (optional)" }
```

- `Cookie: zer0_sid=<uuid>` is honoured if present; otherwise the server
  issues a fresh one on the response. The cookie is `Path=/; Max-Age=1y;
  SameSite=Lax; HttpOnly`.
- `Authorization: Bearer <supabase-access-token>` is optional. If supplied
  and valid, the resulting `user_id` raises the daily cap from 5 → 20.

**Server flow**

1. Resolve `zer0_sid` from the cookie (mint+set if missing or not a UUID).
2. Resolve `user_id` from a Supabase Auth bearer token if present.
3. Compute `fingerprint = sha256(zer0_sid : ip : sha256(ua))` and look up
   or create a `sessions` row keyed by `(user_id ?? anon_fingerprint,
   channel='web')`.
4. Atomic `increment_rate_limit(fingerprint, today)`. Over cap and no
   active `entitlements` row for the session/user → `HTTP 402` with
   `{ paywall: true, reason: "daily_limit_reached", placeholder_charge_url: null }`
   and a `scope='app'` thought is logged.
5. Persist the user message, load the last 10 messages + up to 10 open
   trade recommendations + `ZER0.md` (in parallel), and stream Groq.
6. After the stream closes: insert the assistant message and write an
   `agent_usage` row (`provider='groq'`, `model='llama-3.1-8b-instant'`,
   `step='chat'`).

**Successful response**

`200` with `Content-Type: text/event-stream`. Each chunk is
`data: {"delta":"<token>"}\n\n`; the stream is terminated with
`data: [DONE]\n\n`. The response also sets `Set-Cookie: zer0_sid=…` and
exposes the resolved session as `X-Zer0-Session-Id: <uuid>`.

**Errors**

- `400 { error: "invalid_body", issues }` — body failed Zod validation.
- `402 { paywall: true, reason: "daily_limit_reached", placeholder_charge_url: null }`
  — over the daily cap with no entitlement.
- `500 { error: "chat_failed", message }` — anything else (no stack traces).

### `POST /api/trade/prepare`

Returns the unsigned EIP-712 typed-data payload that the user's wallet must
sign for a `trade_recommendations` row. The relay **never** signs user
orders — this is non-custodial.

**Request body**

```json
{
  "recommendationId": "uuid",
  "userAddress": "0x… (checksummed EVM address)",
  "signatureType": 0,
  "sizeOverrideUsd": 10
}
```

- `signatureType` ∈ {0, 1, 2, 3}: 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE.
- `sizeOverrideUsd` is optional (1–100); falls back to `rec.size`.
- `Cookie: zer0_sid` and `Authorization: Bearer …` are both optional. Anon
  users can prepare a trade as long as they pass a real `userAddress`.

**Successful response (200)**

```json
{
  "tradeId": "uuid",
  "typedData": { "primaryType": "Order", "domain": { … }, "types": { … }, "message": { … } },
  "expiresAt": "ISO-8601 timestamp or null",
  "market": { "question": "…", "condition_id": "0x…" }
}
```

`domain.name` is always `"Polymarket CTF Exchange"`; `domain.chainId` is
`137` (Polygon mainnet); `verifyingContract` is the CTF Exchange or
NegRisk Exchange depending on the market.

**Errors**

- `400` — invalid body / not a real EVM address.
- `404` — `recommendation_not_found`.
- `410` — recommendation expired or status ≠ `open`.
- `422` — size override out of `[1, 100]`.
- `429` — rate-limited (30 req/min per user+IP).
- `500` — CLOB or DB unreachable.

### `POST /api/trade/submit`

Forwards a user-signed CTF order to Polymarket's CLOB and records the
outcome on the `trades` row created by `/api/trade/prepare`.

**Request body**

```json
{
  "tradeId": "uuid",
  "signedOrder": {
    "salt": "…", "maker": "0x…", "signer": "0x…", "taker": "0x0…0",
    "tokenId": "…", "makerAmount": "…", "takerAmount": "…",
    "expiration": "0", "nonce": "0", "feeRateBps": "0",
    "side": "BUY", "signatureType": 0, "signature": "0x…"
  }
}
```

`signedOrder.maker` must match (case-insensitive) the `user_address` stored
on the trade row during `prepare`.

**Successful response (200)**

```json
{ "tradeId": "uuid", "clobOrderId": "…", "status": "submitted", "submittedAt": "ISO-8601" }
```

The route also inserts a `scope='app'` thought summarising the trade.

**Errors**

- `400` — invalid body / malformed signed order shape.
- `403` — maker on signed order does not match the prepare row.
- `404` — `trade_not_found`.
- `409` — already submitted / not in `prepared` state (idempotency).
- `410` — recommendation expired between prepare and submit.
- `422 { error: "clob_rejected", reason }` — CLOB rejected the order.
- `429` — rate-limited (30 req/min per user+IP).
- `503 { error: "clob_unreachable", retry: true }` — transport failure;
  the row stays `prepared` so the client can retry.
