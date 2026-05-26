// Callback-query handler for the inline keyboard.
//
// Callback data:
//   trade:confirm:<pendingId>   — user wants to sign + submit
//   trade:cancel:<pendingId>    — user backed out
//
// On Confirm we:
//   1. AUTHENTICATE: ctx.from.id must equal pending.telegram_user_id.
//      (Telegram's bot token gives us authentic ctx.from.id; we still
//      double-check because nothing prevents user A from forwarding user
//      B's button to a chat where A could tap it.)
//   2. Re-fetch the row from Postgres (typed_data + wallet_meta) so a bot
//      restart between echo and confirm-click doesn't lose state.
//   3. State → AWAITING_WALLET_SIG. Ask the wallet to sign.
//   4. Wrap (sigType 3) or pass-through (sigType 1/2) the signature.
//   5. POST to Polymarket (postOrder; honors POLYMARKET_RELAY_URL).
//   6. State → SUBMITTED → DONE. Edit the original message with the result.

import type { Context } from 'grammy';
import { createAdminClient } from '../../lib/supabase/admin';
import {
  getPendingTrade,
  updatePendingTrade,
} from '../db/pending-trades';
import { requestEip712Sig } from '../wc/sign';
import { wrapErc7739Signature } from '../wc/wrap-1271';
import { postOrder, PostOrderError } from '../polymarket/post-order';
import { exchangeDomainFor } from '../../lib/polymarket/types-v2';
import { getApiCredsForUser } from '../polymarket/api-creds';

interface CallbackData {
  action: 'confirm' | 'cancel';
  pendingId: string;
}

export function parseCallbackData(raw: string): CallbackData | null {
  // Format: trade:confirm:<uuid>  |  trade:cancel:<uuid>
  const m = /^trade:(confirm|cancel):([0-9a-f-]{36})$/.exec(raw);
  if (!m) return null;
  return { action: m[1] as 'confirm' | 'cancel', pendingId: m[2] };
}

export async function handleTradeCallback(ctx: Context): Promise<void> {
  const raw = ctx.callbackQuery?.data;
  if (!raw) return;
  const parsed = parseCallbackData(raw);
  if (!parsed) return;
  if (!ctx.from) {
    await ctx.answerCallbackQuery({ text: 'No identity.', show_alert: false });
    return;
  }

  const supabase = createAdminClient();
  const row = await getPendingTrade(supabase, parsed.pendingId);
  if (!row) {
    await ctx.answerCallbackQuery({ text: 'Trade not found.', show_alert: false });
    return;
  }
  // Authenticate: the tap must be from the user whose intent we recorded.
  if (row.telegramUserId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: 'Not your trade.', show_alert: true });
    return;
  }
  if (row.state === 'EXPIRED' || row.state === 'CANCELLED' || row.state === 'DONE') {
    await ctx.answerCallbackQuery({
      text: `Already ${row.state.toLowerCase()}.`,
      show_alert: false,
    });
    return;
  }

  if (parsed.action === 'cancel') {
    await updatePendingTrade(supabase, row.id, { state: 'CANCELLED' });
    await ctx.answerCallbackQuery({ text: 'Cancelled.' });
    try {
      await ctx.editMessageText('Cancelled.');
    } catch (err) {
      console.warn('[telegram-bot] cancel edit failed', err);
    }
    return;
  }

  // Confirm path.
  await ctx.answerCallbackQuery({ text: 'Signing — check your wallet.' });
  await updatePendingTrade(supabase, row.id, { state: 'AWAITING_WALLET_SIG' });

  const meta = row.walletMeta as
    | {
        funder: string;
        signer: string;
        signatureType: 0 | 1 | 2 | 3;
        requiresErc7739Wrap: boolean;
        eoa: string;
        topic: string;
        negRisk: boolean;
      }
    | null;
  const typedData = row.typedData as
    | { domain: { name: string; version: string; chainId: number; verifyingContract: string }; message: Record<string, unknown> }
    | null;
  if (!meta || !typedData) {
    await updatePendingTrade(supabase, row.id, { state: 'CANCELLED' });
    try {
      await ctx.editMessageText('Internal error: missing trade payload.');
    } catch {
      /* swallow */
    }
    return;
  }

  let innerSig: string;
  try {
    innerSig = await requestEip712Sig({
      topic: meta.topic,
      eoa: meta.eoa,
      typedData,
    });
  } catch (err) {
    console.error('[telegram-bot] wallet sign failed', err);
    await updatePendingTrade(supabase, row.id, { state: 'CANCELLED' });
    try {
      await ctx.editMessageText('Wallet signature failed or timed out.');
    } catch {
      /* swallow */
    }
    return;
  }

  // For sigType 3 the wallet returns the inner ECDSA over the
  // TypedDataSign digest. Wrap to the ERC-7739 envelope. For 1/2 the
  // inner sig is already the contract-acceptable form.
  let signature = innerSig;
  if (meta.requiresErc7739Wrap) {
    try {
      // `typedData.message.contents` holds the Order under the TypedDataSign
      // envelope; that's what gets wrapped.
      const order = (typedData.message as { contents: Parameters<typeof wrapErc7739Signature>[0]['order'] }).contents;
      signature = wrapErc7739Signature({
        innerSig,
        order,
        exchangeDomain: exchangeDomainFor(meta.negRisk),
      });
    } catch (err) {
      console.error('[telegram-bot] erc-7739 wrap failed', err);
      await updatePendingTrade(supabase, row.id, { state: 'CANCELLED' });
      try {
        await ctx.editMessageText('Internal error: signature wrap failed.');
      } catch {
        /* swallow */
      }
      return;
    }
  }

  // Submit. The order wire body is reconstructed from typed-data; we
  // can't store the wire body separately because the prepare path produces
  // both at once and only writes typed_data here.
  // For now, the message under primaryType:'Order' IS the wire-relevant body
  // (numeric side); but POST wants string side. Re-derive carefully.
  const orderMsg = (
    'contents' in typedData.message
      ? (typedData.message as { contents: Record<string, unknown> }).contents
      : (typedData.message as Record<string, unknown>)
  ) as {
    salt: string;
    maker: string;
    signer: string;
    tokenId: string;
    makerAmount: string;
    takerAmount: string;
    side: number;
    signatureType: number;
    timestamp: string;
    metadata: string;
    builder: string;
  };

  let resolvedCreds;
  try {
    resolvedCreds = await getApiCredsForUser(supabase, row.telegramUserId);
  } catch (err) {
    console.error('[telegram-bot] api-creds lookup failed', err);
    await updatePendingTrade(supabase, row.id, { state: 'CANCELLED' });
    try {
      await ctx.editMessageText('Internal error: missing API credentials.');
    } catch {
      /* swallow */
    }
    return;
  }

  await updatePendingTrade(supabase, row.id, { state: 'SUBMITTED' });

  try {
    const resp = await postOrder({
      order: {
        salt: String(orderMsg.salt),
        maker: orderMsg.maker,
        signer: orderMsg.signer,
        taker: '0x0000000000000000000000000000000000000000',
        tokenId: orderMsg.tokenId,
        makerAmount: orderMsg.makerAmount,
        takerAmount: orderMsg.takerAmount,
        side: orderMsg.side === 0 ? 'BUY' : 'SELL',
        signatureType: orderMsg.signatureType,
        timestamp: String(orderMsg.timestamp),
        expiration: '0',
        metadata: orderMsg.metadata,
        builder: orderMsg.builder,
        signature,
      },
      orderType: 'FOK',
      creds: resolvedCreds.creds,
      // POLY_ADDRESS = the api-key owner (the EOA), NOT order.signer. For a
      // sigType-3 deposit wallet, order.signer is the contract while the key
      // belongs to the EOA — the SDK sends the EOA here for every sig type.
      polyAddress: resolvedCreds.polyAddress,
    });
    await updatePendingTrade(supabase, row.id, { state: 'DONE' });
    const orderId = resp.orderID ?? '(no id)';
    try {
      await ctx.editMessageText(
        `✓ Filled.\nOrder ID: ${orderId}\nTx: https://polygonscan.com/tx/${resp.transactionHash ?? ''}`,
        { link_preview_options: { is_disabled: true } },
      );
    } catch {
      /* swallow */
    }
  } catch (err) {
    console.error('[telegram-bot] postOrder failed', err);
    await updatePendingTrade(supabase, row.id, { state: 'CANCELLED' });
    const detail =
      err instanceof PostOrderError
        ? err.body?.errorMsg ?? err.raw.slice(0, 200)
        : err instanceof Error
          ? err.message
          : String(err);
    try {
      await ctx.editMessageText(`Order rejected by Polymarket: ${detail}`);
    } catch {
      /* swallow */
    }
  }
}
