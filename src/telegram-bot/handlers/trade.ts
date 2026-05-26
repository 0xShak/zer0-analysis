// Trade handler — invoked from the text-message router when the intent
// parse yields `open_trade` with confidence >= 0.7.
//
// 1. Look up wallet session (tg_wc_sessions). If none → ask the user to /connect.
// 2. Search Gamma for the user's market query; show resolved name in the echo.
// 3. Look up live book context (best price + min order size).
// 4. Enforce bounds (size, price, slippage, min-order).
// 5. Build the V2 typed-data (sigType-aware, ERC-7739 when type 3).
// 6. INSERT tg_pending_trades(state=AWAITING_USER_CONFIRM).
// 7. Reply with echo + inline-keyboard [Confirm][Cancel].
//
// We DO NOT sign here. Confirm-click → handlers/confirm.ts.

import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { createAdminClient } from '../../lib/supabase/admin';
import {
  buildTypedData,
  getBookContext,
  getMarketMeta,
} from '../../lib/polymarket/clob';
import { enforceBounds } from '../bounds';
import { allowTradeAttempt } from '../trade-rate-limit';
import { searchMarketByQuery } from '../polymarket/market-search';
import { getWcSession } from '../db/sessions';
import { insertPendingTrade, updatePendingTrade } from '../db/pending-trades';
import type { Intent } from '../intent/parse';

export async function handleTradeIntent(
  ctx: Context,
  intent: Intent,
): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  const telegramUserId = ctx.from.id;
  const chatId = ctx.chat.id;

  if (!allowTradeAttempt(telegramUserId)) {
    await ctx.reply("You've hit today's trade limit (10/day). Try again tomorrow.");
    return;
  }

  if (intent.side == null || intent.outcome == null) {
    await ctx.reply(
      "I need a bit more detail. Are you buying or selling, and on YES or NO?",
    );
    return;
  }
  if (intent.size_kind == null || intent.size_value == null) {
    await ctx.reply("How much do you want to trade? (e.g. '$5 of YES')");
    return;
  }

  const supabase = createAdminClient();
  const session = await getWcSession(supabase, telegramUserId);
  if (!session) {
    await ctx.reply("You'll need to connect a wallet first. Send /connect.");
    return;
  }
  if (session.needsOnboarding) {
    await ctx.reply(
      "Your Polymarket wallet isn't provisioned yet. Visit polymarket.com once from the connected wallet (deposit a little USDC), then send /connect again.",
    );
    return;
  }

  if (!intent.market_query) {
    await ctx.reply("Which market? Mention it by name and I'll find it.");
    return;
  }

  const hit = await searchMarketByQuery(intent.market_query);
  if (!hit) {
    await ctx.reply(
      `I couldn't find an active market matching "${intent.market_query}". Try a different phrase.`,
    );
    return;
  }
  const market = hit.market;
  // YES = clobTokenIds[0], NO = clobTokenIds[1] (Polymarket convention).
  const tokenId =
    intent.outcome === 'YES' ? market.clobTokenIds[0] : market.clobTokenIds[1];
  if (!tokenId) {
    await ctx.reply(`Market "${market.question}" doesn't expose a ${intent.outcome} token.`);
    return;
  }

  let meta;
  try {
    meta = await getMarketMeta(market.conditionId);
  } catch (err) {
    console.error('[telegram-bot] getMarketMeta failed', err);
    await ctx.reply("Couldn't load market metadata. Try again in a minute.");
    return;
  }

  let bookCtx;
  try {
    bookCtx = await getBookContext(tokenId, intent.side);
  } catch (err) {
    console.error('[telegram-bot] getBookContext failed', err);
    bookCtx = null;
  }
  const executionPrice = bookCtx?.bestPrice ?? null;
  const midpoint = executionPrice; // No /midpoint call here; reuse executionPrice.
  if (executionPrice == null) {
    await ctx.reply(`No live book on that ${intent.outcome} side — try a more liquid market.`);
    return;
  }

  const bounds = enforceBounds({
    intent,
    midpoint,
    executionPrice,
    minOrderSize: bookCtx?.minOrderSize ?? 0,
  });
  if (!bounds.ok) {
    await ctx.reply(`Trade refused: ${bounds.reason}.`);
    return;
  }

  // We submit market (FOK) orders — confirm.ts posts orderType:'FOK' — so the
  // typed-data MUST be built with market rounding too. The matcher enforces
  // looser per-side precision for market orders (maker ≤2 decimals, taker ≤4)
  // and rejects the limit-order amounts (4-decimal maker) with "invalid
  // amounts, the market buy orders maker amount supports a max accuracy of 2
  // decimals". buildTypedData's market path also expects the V2 SDK size
  // convention: USD for BUY, shares for SELL.
  const usd = intent.size_value;
  const shares = usd / executionPrice;
  const orderSize = intent.side === 'BUY' ? usd : shares;
  let prepared;
  try {
    prepared = await buildTypedData({
      tokenId,
      price: executionPrice,
      size: orderSize,
      side: intent.side,
      maker: session.funderAddress,
      signer: session.signatureType === 3 ? session.funderAddress : session.eoaAddress,
      signatureType: session.signatureType,
      tickSize: meta.tickSize,
      negRisk: meta.negRisk,
      orderType: 'FOK',
    });
  } catch (err) {
    console.error('[telegram-bot] buildTypedData failed', err);
    await ctx.reply("Couldn't build the order. Try again in a minute.");
    return;
  }

  // Persist pending trade with state AWAITING_USER_CONFIRM. Save the
  // typed_data + wallet_meta on the row so Confirm can sign without
  // re-querying Gamma / book (which can drift between echo and click).
  let pending;
  try {
    pending = await insertPendingTrade(supabase, {
      telegramUserId,
      chatId,
      intent,
      state: 'AWAITING_USER_CONFIRM',
    });
    await updatePendingTrade(supabase, pending.id, {
      typedData: prepared.typedData,
      walletMeta: {
        funder: session.funderAddress,
        signer: prepared.order.signer,
        signatureType: session.signatureType,
        walletType: session.walletType,
        requiresErc7739Wrap: session.signatureType === 3,
        eoa: session.eoaAddress,
        topic: session.sessionTopic,
        tokenId,
        conditionId: market.conditionId,
        negRisk: meta.negRisk,
        side: intent.side,
        executionPrice,
        usd,
      },
    });
  } catch (err) {
    console.error('[telegram-bot] insert pending-trade failed', err);
    await ctx.reply("Couldn't save the pending trade. Try again.");
    return;
  }

  const echo = formatEcho({
    market: market.question,
    side: intent.side,
    outcome: intent.outcome,
    usd,
    price: executionPrice,
    shares,
  });
  const kb = new InlineKeyboard()
    .text('Confirm', `trade:confirm:${pending.id}`)
    .text('Cancel', `trade:cancel:${pending.id}`);
  const sent = await ctx.reply(echo, { reply_markup: kb });

  // Stash the message_id so the expiry cron can edit the prompt later.
  try {
    await updatePendingTrade(supabase, pending.id, {
      messageId: sent.message_id,
    });
  } catch (err) {
    console.warn('[telegram-bot] message_id stash failed', err);
  }
}

function formatEcho(args: {
  market: string;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  usd: number;
  price: number;
  shares: number;
}): string {
  const verb = args.side === 'BUY' ? 'Buy' : 'Sell';
  const usd = `$${args.usd.toFixed(2)}`;
  const px = `$${args.price.toFixed(args.price < 0.1 ? 4 : 3)}`;
  const sh = args.shares.toFixed(2);
  return [
    `${verb} ${usd} of ${args.outcome} at ${px} ≈ ${sh} shares`,
    '',
    `Market: ${args.market}`,
    '',
    'Confirm within 90s.',
  ].join('\n');
}
