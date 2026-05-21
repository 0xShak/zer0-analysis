// /connect pairing flow.
//
// Produces a WalletConnect v2 pairing URI + helpful renderings (a
// MetaMask deep link and a QR PNG for any WC2 wallet). The bot sends both
// to the user, then `await approval()` to learn which address signed in
// and persist the session in tg_wc_sessions.

import QRCode from 'qrcode';
import { getSignClient } from './sign-client';

const POLYGON_CAIP2 = 'eip155:137';

const REQUIRED_NAMESPACES = {
  eip155: {
    chains: [POLYGON_CAIP2],
    methods: ['eth_signTypedData_v4', 'personal_sign'],
    events: ['chainChanged', 'accountsChanged'],
  },
};

export interface PairPayload {
  /** Raw wc: URI — render as QR or hand to a deeplink intent. */
  uri: string;
  /** iOS-flavored MetaMask universal link. */
  deepLink: string;
  /** Android fallback (the universal link occasionally redirects through Branch.io and fails). */
  androidDeepLink: string;
  /** PNG-encoded QR code, ready to ship as InputFile to ctx.replyWithPhoto. */
  qrPng: Buffer;
  /**
   * Awaiter for the wallet's approval message. Resolves with the session
   * once the wallet user accepts. Reject this if the user never approves —
   * the caller should set a UI timeout (90s is a sane default).
   */
  approval: () => Promise<WalletApproval>;
}

export interface WalletApproval {
  topic: string;
  eoa: string;
}

export async function pairForTelegramUser(): Promise<PairPayload> {
  const client = await getSignClient();
  const { uri, approval } = await client.connect({
    requiredNamespaces: REQUIRED_NAMESPACES,
  });
  if (!uri) throw new Error('walletconnect connect() returned no URI');

  const encodedUri = encodeURIComponent(uri);
  const deepLink = `https://metamask.app.link/wc?uri=${encodedUri}`;
  const androidDeepLink = `metamask://wc?uri=${encodedUri}`;
  const qrPng = await QRCode.toBuffer(uri);

  return {
    uri,
    deepLink,
    androidDeepLink,
    qrPng,
    approval: async () => {
      const session = await approval();
      const accounts = session.namespaces.eip155?.accounts ?? [];
      if (accounts.length === 0) {
        throw new Error('approved session contained no eip155 accounts');
      }
      // Account string is `eip155:137:0xabc…`; we want the bare address.
      const eoa = accounts[0].split(':')[2];
      return { topic: session.topic, eoa };
    },
  };
}
