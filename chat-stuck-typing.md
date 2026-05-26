# ZER0 chat — "stuck on Typing… then silent" (Engineer Handoff)

> **Purpose:** hand off ONE bug to the next engineer with full context so it can be
> fixed without re-deriving everything. Read top to bottom once. Line numbers may
> have drifted — verify against current source.

---

## Symptom

In the Telegram bot, **conversational** messages (anything that isn't a tight,
explicit trade instruction) show the "Typing…" indicator for ~2–3 seconds, then
the indicator disappears and **no reply is ever sent**. The bot silently "forgets
to reply."

Reproduction signal from the product owner: *"depending what message — if it's
not a super specific prompt — it gets stuck on Typing… for 2–3 seconds, then it
stops Typing and doesn't send anything."*

Tight trade prompts (e.g. "buy $5 of YES on the Bitcoin market") DO work and reply
normally. Vague/conversational prompts ("what do you think?", "what markets look
good?", greetings, open questions) are the ones that go silent.

---

## Why "specific works, vague fails" — the architecture split

The two message classes take **completely different code paths**:

```
User msg ──► handlers/ask.ts (BOT, PM2 on the VPS)
              1. replyWithChatAction('typing')         ← one-shot, ~5s, no keep-alive
              2. parseIntent(text)  (Groq 8B classifier, ~2-3s)
              3. branch:
                 ├─ open_trade & conf≥0.7 ──► handleTradeIntent()  [ALL bot-side] ✅ works
                 ├─ open_trade & conf<0.7 ──► clarifying reply      [bot-side]     ✅ works
                 └─ everything else ────────► inngest.send(chatMessageReceived)
                                                      │
                                                      ▼
                              Inngest Cloud ──► Vercel /api/inngest
                                                      │
                                              chat-respond function:
                                                load-context → groq-completion → persist-and-deliver
                                                      │ (writes messages + outbound_messages rows)
                                                      ▼
                              Supabase Realtime INSERT on outbound_messages
                                                      │
                              telegram-bot/outbound.ts listener ──► bot.api.sendMessage()  ──► user
```

- **Specific trade prompts** are resolved entirely inside the bot (`handleTradeIntent`)
  and never touch the Vercel chat pipeline → they work.
- **Vague/chat prompts** are handed off to `chat-respond` on **Vercel** (the bot only
  fires an Inngest event and returns; the reply comes back asynchronously over the
  Supabase-Realtime `outbound_messages` channel). **The failure is in this Vercel
  pipeline.**

The "Typing…" indicator is a single `replyWithChatAction('typing')` (ask.ts ~line 68)
with **no keep-alive** — Telegram shows it for ~5s and then drops it. So when the
async reply never arrives, the user sees exactly "typed for a couple seconds, then
nothing."

---

## Evidence already gathered (trust these; don't re-derive)

Queried prod Supabase (REST, service key) on 2026-05-25:

- `messages` where `role=assistant` AND `content=''` → **0 rows**.
- `outbound_messages` where `content=''` → **0 rows**.
- `outbound_messages` where `delivered_at IS NULL` (all-time) → **0 rows**.
- Totals: 73 assistant messages, 34 outbound rows (the gap is web-channel replies,
  which don't create outbound rows).

**Interpretation:** whenever `chat-respond` reaches its final `persist-and-deliver`
step, the content is non-empty AND delivery succeeds. The failing prompts leave
**no trace at all** — no assistant message, no outbound row. Therefore
**`chat-respond` is dying BEFORE the persist step**, i.e. in `load-context` or (far
more likely) the `groq-completion` step. It is NOT an empty-message or a delivery
problem (those are real latent bugs — see below — but they are not what's biting
right now).

Bot-side `inngest.send()` has failed only **3 times ever** in the PM2 error log, so
the hand-off event itself is reliable; the problem is downstream on Vercel.

---

## Leading root cause (HIGH confidence, not yet confirmed in Vercel logs)

**Groq free-tier 429 contention, thrown instantly because the client has
`maxRetries: 0`.**

- `chat-respond` (`groq-completion` step) and `brain-tick` are registered on the
  **same** Vercel route (`src/app/api/inngest/route.ts` → `functions: [brainTick,
  chatRespond]`) and both call the **same free-tier Groq** (30 requests/min).
- `brain-tick` fires **concurrent** Groq classifier calls (`Promise.all(batch.map(
  classifyOne))`, brain-tick.ts ~line 269). When a tick is running it can saturate
  the 30 RPM.
- The shared Groq client (`src/lib/groq.ts`) is deliberately `maxRetries: 0,
  timeout: 15_000` (to "fail fast" and not pin the Vercel budget on the 30s
  Retry-After). So a chat request that lands during a tick gets a **429 and throws
  immediately (~2-3s)** — matching the observed timing exactly.
- The throw propagates out of `step.run('groq-completion')`. Inngest retries the
  step (default 4 attempts), but if the contention persists every attempt 429s,
  the function ultimately **fails with no `onFailure` handler** → nothing is
  persisted, nothing is delivered, the user gets silence.

This also explains the "depends on the message" perception: it actually depends on
**timing relative to brain ticks / other Groq traffic**, which from the user's seat
looks like "certain messages fail."

⚠️ **This is a hypothesis built from code + DB evidence.** The **definitive** signal
is in the **Inngest Cloud dashboard** and **Vercel function logs** for failed
`zer0-chat-respond` runs — the actual thrown error (429 vs 15s timeout vs context
vs something else) is printed there. **Neither the previous engineer nor an agent on
the VPS can read those logs** — START THE INVESTIGATION THERE.

Less-likely-but-possible alternates to rule out from the same logs:
- 15s `timeout` tripping on genuinely long completions (`max_tokens: 1500`). Slower
  than 2-3s though, so probably not the primary.
- `load-context` query throwing (not content-correlated; unlikely).
- A Groq content-moderation rejection on certain inputs (would 400/throw, fast).

---

## Latent bugs to fix while you're in here (NOT the current trigger, but will bite)

1. **Empty-content → empty Telegram send → silently swallowed.**
   `chat-respond.ts` does `reply = resp.choices[0]?.message?.content ?? ''`. If Groq
   ever returns empty content (e.g. `finish_reason: content_filter`), it persists
   `''` and `outbound.ts deliver()` calls `bot.api.sendMessage(chatId, '')`, which
   Telegram rejects with **400 "message text is empty"**. `deliver()`'s catch treats
   400 as "chat not found/blocked", marks the row delivered, and swallows it →
   another silent path. (Currently 0 empty rows, so not active — but it's a trap.)

2. **No user-facing failure anywhere.** When `chat-respond` fails, nothing tells the
   user. `ask.ts` line ~108 `await inngest.send(...)` isn't even wrapped in
   try/catch — a send failure throws out of the handler and the user gets nothing.

3. **Tight Groq config for the chat path.** `maxRetries: 0` + `timeout: 15_000` are
   tuned for the batch/brain path's budget concerns, but they make interactive chat
   fragile under any contention.

---

## The task / proposed fix set (prioritized)

Order matters: **#1 makes the bug non-silent regardless of root cause** — ship it
first so users always get *something*, then root-cause and tune.

1. **Never leave the user on silent typing.** Add an Inngest `onFailure` handler to
   `chatRespond` (or wrap the step body) that, on terminal failure, queues a
   fallback `outbound_messages` row ("I had trouble with that one — try again in a
   sec") so the bot always delivers a reply. Carry `sessionId/userId/telegramChatId`
   into the failure handler (they're on `event.data`).

2. **Guard empty content.** In `chat-respond`, if `reply.trim()` is empty, substitute
   a fallback string before persist/deliver. AND in `outbound.ts deliver()`, skip /
   replace empty `content` so `sendMessage('')` can never be called.

3. **Make the chat Groq call resilient to 429.** Options (pick based on what the
   dashboard shows):
   - Give the chat path its own Groq client config with a small `maxRetries`
     (1–2) and a short, bounded backoff that respects Retry-After but caps within
     the 60s Vercel budget (`maxDuration = 60` in the route).
   - Throttle contention: set Inngest `concurrency`/throttle on `brain-tick` (and/or
     `chat-respond`) so ticks don't starve interactive chat of the 30 RPM.
   - Consider a paid Groq tier or a separate key for interactive chat vs the brain.

4. **Wrap `ask.ts`'s `inngest.send`** in try/catch; on failure, reply with the same
   fallback so the rare bot-side send error isn't silent either.

5. **Add a keep-alive typing loop (optional polish).** Re-send `chat action 'typing'`
   every ~4s until the reply lands (or a timeout), so the UX matches the async wait.
   Lower priority than not-being-silent.

6. **Add instrumentation** to `chat-respond` (log around `groq-completion`:
   model, latency, finish_reason, error name/status) so the next failure is
   diagnosable from logs directly.

Items #1, #2, #4, #6 require **no Vercel-log access** and can be implemented and
unit-tested immediately. #3 should be tuned after confirming the error class in the
dashboard.

---

## How to verify

1. **Confirm the root cause first:** open the Inngest Cloud dashboard → `zer0`
   app → `zer0-chat-respond` → look at recent **failed** runs and read the
   `groq-completion` step error. Cross-check Vercel function logs for the same
   window. Confirm 429 vs timeout vs other. (Try sending several vague prompts
   while a brain tick is running to provoke it.)
2. **After #1/#2/#4:** send a vague prompt that previously went silent → you should
   now ALWAYS get either a real answer or the fallback message, never silence.
3. **After #3:** repeatedly send vague prompts during brain ticks → real answers,
   no fallbacks (or far fewer).
4. **Unit tests** (tests/, `@/` alias, `pnpm test`): mock the Groq client to throw a
   429 and assert `chat-respond`'s failure path queues a fallback outbound row;
   assert `outbound.ts deliver()` never calls `sendMessage` with empty text. Follow
   the injection style in `tests/derive-api-creds.test.ts`.

---

## Operational notes / gotchas

- **Chat-respond runs on Vercel, NOT the VPS.** `INNGEST_DEV=0` with
  `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` set → the bot sends events to Inngest
  Cloud, which invokes the Vercel `/api/inngest` deployment. So **code changes to
  `chat-respond` only take effect on a Vercel deploy** — restarting the PM2 bot does
  nothing for them. (`outbound.ts` and `ask.ts` changes DO need a PM2 bot restart:
  `pm2 restart zer0-telegram-bot`.)
- **The local `zer0-inngest-dev` PM2 process is the local dev Inngest server** — it
  does NOT serve prod. Leave it; don't confuse it with the cloud path.
- **The bot runs under PM2** (`zer0-telegram-bot`, id 0), runs `tsx` (no build step).
  Logs: `/root/.pm2/logs/zer0-telegram-bot-{out,error}.log`. Do NOT start a second
  poller (causes Telegram 409 `Conflict: terminated by other getUpdates`).
- **Free-tier Groq is 30 RPM.** That ceiling is the heart of the contention. Models:
  `GROQ_MODELS.CHAT = 'llama-3.3-70b-versatile'`, `CLASSIFIER = 'llama-3.1-8b-instant'`
  (`src/lib/groq.ts`). llama-3.3-70b is NOT a reasoning model, so empty content is
  not a "reasoning ate the tokens" issue.
- **Env file is `.env.local`** (`tsx --env-file=.env.local`). No `.env`.
- **tsconfig `target` < ES2020:** bigint literals (`0n`) don't compile (TS2737) even
  though vitest accepts them — use `BigInt(0)`. Run `npx tsc --noEmit` after edits.
  (Note: there is a pre-existing, unrelated `.next/types/validator.ts` TS2307 error
  about `app/api/trade/submit/route.js` — ignore it; it's not from your changes.)
- This is a **modified Next.js** (see `AGENTS.md`) — read `node_modules/next/dist/docs/`
  before touching routes.

---

## Key file & symbol references

- `src/telegram-bot/handlers/ask.ts` — message router; shows typing, runs
  `parseIntent`, branches to trade vs `inngest.send(chatMessageReceived)`. The
  unguarded `inngest.send` is here (~line 108).
- `src/telegram-bot/intent/parse.ts` — `parseIntent` (Groq 8B classifier; the ~2-3s
  cost before the branch). Throws `IntentParseError` on bad JSON (caught & falls
  through); a raw Groq throw here would crash the handler.
- `src/lib/inngest/functions/chat-respond.ts` — **the failing function.** Steps:
  `load-context`, `groq-completion` (the throw point), `persist-and-deliver` (writes
  `messages` + `outbound_messages`). No `onFailure`. `reply = content ?? ''`.
- `src/lib/inngest/functions/brain-tick.ts` — the Groq-saturating neighbor
  (`Promise.all(batch.map(classifyOne))`, ~line 269); shares the 30 RPM.
- `src/lib/groq.ts` — shared Groq client: `maxRetries: 0`, `timeout: 15_000`.
- `src/lib/chat/context.ts` — `loadChatContext` (history + trades + markets +
  thoughts + persona), `CHAT_GROUND_RULES`, formatters.
- `src/app/api/inngest/route.ts` — registers `[brainTick, chatRespond]` on Vercel;
  `maxDuration = 60`.
- `src/telegram-bot/outbound.ts` — Supabase-Realtime listener → `deliver()` →
  `bot.api.sendMessage`. Swallows 400/403 as "delivered." Empty-text trap is here
  (~line 80).
- `src/lib/inngest/client.ts` — `inngest`, `chatMessageReceived` event.
- DB tables: `messages`, `outbound_messages` (has `delivered_at`, `telegram_chat_id`).

---

## What is NOT this bug (so you don't chase it)

- The **trade pipeline is healthy.** Per-user CLOB auth, order amounts, and submit
  all work end-to-end (last prod attempt reached the matcher and returned a normal
  `not enough balance / allowance` fee error, not auth/amounts). Don't touch
  `post-order.ts`, `derive-api-creds.ts`, `confirm.ts`, `trade.ts` for this bug.
- It is **not** an empty-string-delivery problem right now (0 empty rows) — though
  fix the latent trap anyway (#2).
- It is **not** the bot-side `inngest.send` (3 failures ever) — though guard it (#4).
