// Resolve an EOA → on-chain trading identity (funder + signature type).
//
// Polymarket's V2 CLOB doesn't trade against raw EOAs anymore — it requires
// one of three on-chain "trading wallet" shapes:
//
//   1. POLY_PROXY (sigType 1)       — legacy gnosis-safe-like proxy.
//   2. POLY_GNOSIS_SAFE (sigType 2) — gnosis safe 1/n owned by the EOA.
//   3. POLY_1271 (sigType 3)        — deterministic CREATE2 "deposit wallet"
//                                     for new (post-2026) users. Funder
//                                     address is predicted from the EOA via
//                                     the factory at 0x00000000000Fb5C9...
//
// Polymarket exposes the resolved mapping at the data-api endpoint
// (`/resolve/<eoa>`), which returns whichever wallet shape (if any) is
// already in use. If no row exists the user is a "new" user and we default
// to the type-3 deposit-wallet branch — but we don't try to predict the
// CREATE2 address locally because the factory bytecode/init-code is
// undocumented; instead we surface that the user must visit polymarket.com
// once to provision their deposit wallet, and store the resolved
// funder/sigType on first successful trade.
//
// This helper is fetch-only (no Polymarket SDK dependency) so it stays
// trivially testable: pass in a custom fetch via `args.fetchImpl` from
// tests, mock the response, assert the four branches.

import { POLYMARKET_DEPOSIT_WALLET_FACTORY } from './deposit-wallet';

export type WalletType = 'eoa' | 'proxy' | 'safe' | 'deposit_wallet';
export type SignatureTypeNum = 0 | 1 | 2 | 3;

export interface WalletResolution {
  /** The on-chain account that holds pUSD and the user's CTF positions. */
  funder: string;
  /** The address whose ECDSA key signs orders (the EOA for type 1/2; the deposit wallet for type 3). */
  signer: string;
  signatureType: SignatureTypeNum;
  walletType: WalletType;
  /** True when the user needs to visit polymarket.com to bootstrap their deposit wallet. */
  needsOnboarding: boolean;
}

const DEFAULT_RESOLVE_ENDPOINT =
  'https://data-api.polymarket.com/resolve/';

interface ResolveResponse {
  // Shape varies; we read defensively.
  proxyAddress?: string;
  safeAddress?: string;
  depositWalletAddress?: string;
  walletType?: string;
  funder?: string;
  signatureType?: number;
}

export interface ResolveWalletArgs {
  eoa: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Resolve an EOA to its on-chain Polymarket trading identity.
 *
 * Branches:
 *   - proxyAddress present       → { funder=proxy, signer=eoa, type=1, walletType='proxy' }
 *   - safeAddress present        → { funder=safe,  signer=eoa, type=2, walletType='safe'  }
 *   - depositWalletAddress       → { funder=wallet, signer=wallet, type=3, walletType='deposit_wallet' }
 *   - none of the above (new)    → { funder=eoa,   signer=eoa, type=3, walletType='deposit_wallet',
 *                                    needsOnboarding=true }
 *
 * Throws only on network errors; a 404 / empty body resolves to the "new
 * user" branch above so the caller can surface a polymarket.com onboarding
 * prompt.
 */
export async function resolveWallet(
  args: ResolveWalletArgs,
): Promise<WalletResolution> {
  const eoa = args.eoa;
  const fetchImpl = args.fetchImpl ?? fetch;
  const endpoint = (args.endpoint ?? DEFAULT_RESOLVE_ENDPOINT) + eoa;

  let body: ResolveResponse | null = null;
  try {
    const res = await fetchImpl(endpoint);
    if (res.status === 200) {
      body = (await res.json()) as ResolveResponse;
    } else if (res.status !== 404) {
      // Any non-404 non-200 is a transient API error; bubble.
      throw new Error(`resolve-wallet: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    // Network-level failure (fetch threw) — re-throw so the bot can reply
    // "Polymarket lookup failed, try again". A 404 above is treated as
    // "new user" and doesn't enter this branch.
    if (err instanceof Error && err.message.startsWith('resolve-wallet:')) {
      throw err;
    }
    throw new Error(
      `resolve-wallet: network error contacting ${endpoint} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (body?.proxyAddress) {
    return {
      funder: body.proxyAddress,
      signer: eoa,
      signatureType: 1,
      walletType: 'proxy',
      needsOnboarding: false,
    };
  }
  if (body?.safeAddress) {
    return {
      funder: body.safeAddress,
      signer: eoa,
      signatureType: 2,
      walletType: 'safe',
      needsOnboarding: false,
    };
  }
  if (body?.depositWalletAddress) {
    return {
      funder: body.depositWalletAddress,
      signer: body.depositWalletAddress,
      signatureType: 3,
      walletType: 'deposit_wallet',
      needsOnboarding: false,
    };
  }

  // No mapping found — new user. Polymarket V2 rejects raw EOAs with
  // "maker address not allowed, please use the deposit wallet flow". The
  // CREATE2 deposit-wallet address is deterministic per EOA but the
  // factory's init-code is undocumented; rather than guess, surface a
  // bootstrap step so the user provisions through polymarket.com first.
  void POLYMARKET_DEPOSIT_WALLET_FACTORY; // imported for future CREATE2 prediction.
  return {
    funder: eoa,
    signer: eoa,
    signatureType: 3,
    walletType: 'deposit_wallet',
    needsOnboarding: true,
  };
}
