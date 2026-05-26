// /connect — pair this Telegram chat with the user's wallet over WC2.
//
// Flow:
//   1. Open a WC pairing (uri + deepLink + QR).
//   2. Reply with the deep link + the QR PNG so the user can pick.
//   3. await approval() — resolves on wallet acceptance.
//   4. Resolve the EOA → on-chain trading identity (funder + sigType).
//   5. Persist {topic, eoa, funder, sigType, walletType} in tg_wc_sessions.
//   6. Reply confirming connection.

import type { Context } from 'grammy';
import { InputFile } from 'grammy';
import { createAdminClient } from '../../lib/supabase/admin';
import { resolveWallet } from '../polymarket/resolve-wallet';
import { saveWcSession } from '../db/sessions';
import { getClobApiCreds, saveClobApiCreds } from '../db/clob-creds';
import { deriveClobApiCreds } from '../polymarket/derive-api-creds';
import { requestEip712Sig } from '../wc/sign';
import { pairForTelegramUser } from '../wc/pair';

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export async function handleConnect(ctx: Context): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("Couldn't identify you on Telegram's side.");
    return;
  }

  let pair;
  try {
    pair = await pairForTelegramUser();
  } catch (err) {
    console.error('[telegram-bot] /connect pair failed', err);
    await ctx.reply("Couldn't start a wallet connection right now. Try again in a minute.");
    return;
  }

  await ctx.reply(`Tap to connect MetaMask:\n${pair.deepLink}`, {
    link_preview_options: { is_disabled: true },
  });
  await ctx.reply(`On Android if the link bounces:\n${pair.androidDeepLink}`, {
    link_preview_options: { is_disabled: true },
  });
  try {
    await ctx.replyWithPhoto(new InputFile(pair.qrPng, 'connect.png'), {
      caption: 'Or scan with any WalletConnect-compatible wallet (Trust, Rainbow, Coinbase, Phantom).',
    });
  } catch (err) {
    // Telegram occasionally rejects photo uploads (rate-limit, MIME, etc.).
    // Fail open — the deep link above is enough for most users.
    console.warn('[telegram-bot] /connect QR upload failed', err);
  }

  let approval;
  try {
    approval = await Promise.race([
      pair.approval(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('approval timed out')), APPROVAL_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    console.error('[telegram-bot] /connect approval failed', err);
    await ctx.reply(
      "Wallet approval didn't arrive (5 min timeout). Run /connect to try again.",
    );
    return;
  }

  let resolution;
  try {
    resolution = await resolveWallet({ eoa: approval.eoa });
  } catch (err) {
    console.error('[telegram-bot] /connect resolveWallet failed', err);
    await ctx.reply(
      "Couldn't resolve your Polymarket account just now. Your wallet IS connected — try sending a message in a minute.",
    );
    return;
  }

  try {
    const supabase = createAdminClient();
    await saveWcSession(supabase, {
      telegramUserId: ctx.from.id,
      sessionTopic: approval.topic,
      eoaAddress: approval.eoa,
      funderAddress: resolution.funder,
      signatureType: resolution.signatureType,
      walletType: resolution.walletType,
      needsOnboarding: resolution.needsOnboarding,
    });
  } catch (err) {
    console.error('[telegram-bot] /connect saveWcSession failed', err);
    await ctx.reply("Wallet connected, but I couldn't save the session. Try again.");
    return;
  }

  const shortEoa = `${approval.eoa.slice(0, 6)}…${approval.eoa.slice(-4)}`;

  // A brand-new account can't trade until it's provisioned on polymarket.com,
  // and we can't derive a usable api-key for an undeployed wallet — so stop
  // here and don't ask for the (useless) authorize-trading signature.
  if (resolution.needsOnboarding) {
    await ctx.reply(
      `Connected ${shortEoa} (${resolution.walletType}).\n\n` +
        'One more thing — looks like a brand-new Polymarket account. Visit polymarket.com once ' +
        'from the same wallet to provision your deposit wallet, then run /connect again. Until ' +
        'then V2 trades will be refused.',
    );
    return;
  }

  // Per-user CLOB credentials. The api-key binds to the EOA that signs (the
  // connecting wallet) and the L2 POLY_ADDRESS header must carry that same EOA
  // — exactly what Polymarket's own SDK does for every signature type, including
  // sigType-3 deposit wallets (where the order's signer is the contract but the
  // key still belongs to the EOA that owns it). Derive once via a single
  // ClobAuth signature and cache it; later trades reuse it and only prompt for
  // the per-order signature.
  try {
    const supabase = createAdminClient();
    const existing = await getClobApiCreds(supabase, ctx.from.id);
    const haveCurrent =
      existing &&
      existing.signerAddress.toLowerCase() === approval.eoa.toLowerCase();

    if (!haveCurrent) {
      await ctx.reply(
        'One more signature to authorize trading — gasless and one-time. Check your wallet…',
      );
      const creds = await deriveClobApiCreds({
        signerAddress: approval.eoa,
        signTypedData: (typedData) =>
          requestEip712Sig({ topic: approval.topic, eoa: approval.eoa, typedData }),
      });
      await saveClobApiCreds(supabase, {
        telegramUserId: ctx.from.id,
        signerAddress: approval.eoa,
        creds,
      });
    }
  } catch (err) {
    console.error('[telegram-bot] /connect creds derivation failed', err);
    await ctx.reply(
      `Connected ${shortEoa} (${resolution.walletType}), but I couldn't finish authorizing ` +
        'trading (the signature was declined or timed out). Run /connect again to retry — ' +
        "trades won't go through until this succeeds.",
    );
    return;
  }

  await ctx.reply(
    `Connected ${shortEoa} (${resolution.walletType}). Trading is authorized — you can now ask me about markets and trade in chat.`,
  );
}
