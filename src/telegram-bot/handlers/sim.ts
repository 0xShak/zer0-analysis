// /sim handler — run a MiroShark swarm simulation from Telegram.
//
// Two entry points:
//   handleSimCommand  — the explicit `/sim <scenario>` command.
//   handleSimIntent   — the intent-parser branch (run_sim, confidence >= 0.7),
//                       reached from handlers/ask.ts like open_trade → trade.ts.
//
// Both funnel into requestSimForTelegram, which gates on the payment switch:
//   payment OFF → fire immediately, tell the user we'll ping them.
//   payment ON  → quote the price + show a [Pay] / [Cancel] keyboard; the tap
//                 is handled by handleSimCallback → wc/pay.ts.
//
// Delivery of the finished result is async over outbound_messages (sim-run
// inserts the row; the existing outbound listener forwards it) — no synchronous
// wait, mirroring the chat pipeline.

import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { createAdminClient } from '../../lib/supabase/admin';
import { createSimRequest } from '../../lib/sims/request';
import { getPendingSim, updatePendingSim } from '../../lib/sims/db';
import { getOrCreateTelegramSession, upsertTelegramUser } from '../db';
import { allowSimRequest } from '../trade-rate-limit';
import { processSimPayment } from '../wc/pay';

const MIN_SCENARIO_LEN = 8;

const RUNNING_MESSAGE =
  '🦈 Running your MiroShark sim now — hundreds of agents, a few minutes of wall-clock. I\'ll ping you here the moment it lands.';

export async function handleSimCommand(ctx: Context): Promise<void> {
  // `ctx.match` is everything after "/sim".
  const scenario = (ctx.match ?? '').toString().trim();
  if (!scenario) {
    await ctx.reply(
      'Give me a scenario to simulate, e.g. /sim what happens to BTC if the Fed cuts rates in March',
    );
    return;
  }
  await requestSimForTelegram(ctx, scenario);
}

export async function handleSimIntent(
  ctx: Context,
  scenario: string,
): Promise<void> {
  await requestSimForTelegram(ctx, scenario);
}

async function requestSimForTelegram(
  ctx: Context,
  scenario: string,
): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  if (scenario.trim().length < MIN_SCENARIO_LEN) {
    await ctx.reply(
      'That scenario is a bit thin — give me a full sentence and I\'ll simulate it.',
    );
    return;
  }
  if (!allowSimRequest(ctx.from.id)) {
    await ctx.reply("You've hit today's sim limit (5/day). Try again tomorrow.");
    return;
  }

  const supabase = createAdminClient();
  const userId = await upsertTelegramUser(
    supabase,
    ctx.from.id,
    ctx.from.first_name ?? null,
  );
  const sessionId = await getOrCreateTelegramSession(supabase, userId);

  const result = await createSimRequest(supabase, {
    channel: 'telegram',
    scenario: scenario.trim(),
    userId,
    sessionId,
    telegramUserId: ctx.from.id,
    telegramChatId: ctx.chat.id,
  });

  if (!result.needsPayment) {
    await ctx.reply(RUNNING_MESSAGE);
    return;
  }

  // Payment gate is on — quote and wait for the tap.
  const quote = result.quote!;
  const kb = new InlineKeyboard()
    .text(`Pay ${quote.priceZer0} $ZER0`, `sim:pay:${result.pendingSim.id}`)
    .text('Cancel', `sim:cancel:${result.pendingSim.id}`);
  await ctx.reply(
    [
      `One swarm sim costs ${quote.priceZer0} $ZER0 (on Base).`,
      '',
      `Scenario: ${scenario.trim()}`,
      '',
      'Tap Pay to send it from your connected wallet — I\'ll verify on-chain and kick off the run.',
    ].join('\n'),
    { reply_markup: kb },
  );
}

interface SimCallbackData {
  action: 'pay' | 'cancel';
  pendingId: string;
}

export function parseSimCallbackData(raw: string): SimCallbackData | null {
  const m = /^sim:(pay|cancel):([0-9a-f-]{36})$/.exec(raw);
  if (!m) return null;
  return { action: m[1] as 'pay' | 'cancel', pendingId: m[2] };
}

export async function handleSimCallback(ctx: Context): Promise<void> {
  const raw = ctx.callbackQuery?.data;
  if (!raw) return;
  const parsed = parseSimCallbackData(raw);
  if (!parsed || !ctx.from) return;

  const supabase = createAdminClient();
  const pending = await getPendingSim(supabase, parsed.pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'Sim request not found.' });
    return;
  }
  // Authenticate the tap, mirroring trade confirm.ts.
  if (pending.telegram_user_id !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: 'Not your sim.', show_alert: true });
    return;
  }
  if (pending.state !== 'AWAITING_PAYMENT') {
    await ctx.answerCallbackQuery({
      text: `Already ${pending.state.toLowerCase()}.`,
    });
    return;
  }

  if (parsed.action === 'cancel') {
    await updatePendingSim(supabase, pending.id, { state: 'CANCELLED' });
    await ctx.answerCallbackQuery({ text: 'Cancelled.' });
    try {
      await ctx.editMessageText('Cancelled.');
    } catch {
      /* swallow */
    }
    return;
  }

  // Pay path → WalletConnect eth_sendTransaction on Base + on-chain verify.
  await ctx.answerCallbackQuery({ text: 'Check your wallet to approve the payment.' });
  await processSimPayment(ctx, supabase, pending);
}
