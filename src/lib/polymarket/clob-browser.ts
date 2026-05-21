// Browser-side Polymarket CLOB V2 client.
//
// Why this exists: Polymarket geoblocks ~33 countries on `POST /order`,
// including the US (where Vercel's Hobby plan pins our Node functions to
// `iad1`). Doing the submit from the user's own browser sidesteps the block
// since Polymarket sees the user's residential IP instead of our function's.
//
// V2 mandates the deposit-wallet flow: every order's `maker`/`signer` must be
// the user's deposit wallet (an ERC-1967 proxy keyed off their EOA, deployed
// via Polymarket's relayer). We sign with `signatureType = POLY_1271 = 3`
// and an ERC-7739 wrapped signature — the deposit wallet's `isValidSignature`
// parses the wrap, recovers the EOA, and approves the order.
//
// Trade-offs:
//   - One additional MetaMask popup per user, ONCE, to derive their
//     Polymarket HMAC API key from an EIP-712 signature. Cached in
//     localStorage keyed by EOA so subsequent trades skip it.
//   - The Polymarket SDK ships browser-safe (browser-or-node detection,
//     WebCrypto for HMAC, axios for HTTP). No webpack tweaks needed.

import {
  ClobClient,
  OrderType,
  SignatureTypeV2,
  type ApiKeyCreds,
  type SignedOrder,
} from '@polymarket/clob-client-v2';
import { providers } from 'ethers';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function credsCacheKey(address: string): string {
  return `zer0:pm-creds:${address.toLowerCase()}`;
}

export function hasCachedCreds(address: string): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(credsCacheKey(address)) != null;
}

function loadCachedCreds(address: string): ApiKeyCreds | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(credsCacheKey(address));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ApiKeyCreds>;
    if (
      typeof parsed.key === 'string' &&
      typeof parsed.secret === 'string' &&
      typeof parsed.passphrase === 'string'
    ) {
      return parsed as ApiKeyCreds;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCachedCreds(address: string, creds: ApiKeyCreds): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(credsCacheKey(address), JSON.stringify(creds));
}

export function clearCachedCreds(address?: string): void {
  if (typeof window === 'undefined') return;
  if (address) {
    window.localStorage.removeItem(credsCacheKey(address));
    return;
  }
  for (let i = window.localStorage.length - 1; i >= 0; i--) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith('zer0:pm-creds:')) {
      window.localStorage.removeItem(k);
    }
  }
}

// Builds a Polymarket V2 ClobClient bound to the connected wallet's signer
// and the user's deposit wallet (the on-chain funder). The first call per
// EOA prompts the user to sign Polymarket's API-key derivation challenge
// (one extra MetaMask popup). Subsequent calls reuse cached creds.
export async function getOrCreatePolymarketClient(
  ethereum: EthereumProvider,
  address: string,
  depositWalletAddress: string,
): Promise<ClobClient> {
  // ethers v5 Web3Provider over the injected EIP-1193 provider. The cast
  // is necessary because the EIP-1193 type we use locally is narrower than
  // ethers' ExternalProvider — the runtime shape is identical.
  const provider = new providers.Web3Provider(
    ethereum as unknown as providers.ExternalProvider,
    {
      chainId: CHAIN_ID,
      name: 'matic',
    },
  );
  const signer = provider.getSigner(address);

  let creds = loadCachedCreds(address);
  if (!creds) {
    const bootstrap = new ClobClient({
      host: HOST,
      chain: CHAIN_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signer: signer as any,
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: depositWalletAddress,
    });
    creds = await bootstrap.createOrDeriveApiKey();
    saveCachedCreds(address, creds);
  }

  return new ClobClient({
    host: HOST,
    chain: CHAIN_ID,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: signer as any,
    creds,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: depositWalletAddress,
  });
}

// Submits a V2 POLY_1271 signed order as FAK (fill-and-kill). The SDK's
// `isV2Order` detection picks `orderToJsonV2` automatically once it sees
// timestamp + metadata + builder on the input.
export async function submitOrderFromBrowser(
  client: ClobClient,
  signedOrder: SignedOrder,
): Promise<unknown> {
  return client.postOrder(signedOrder, OrderType.FAK);
}

export type BrowserOrderResolution =
  | { kind: 'matched'; sizeMatched: string; status: string }
  | { kind: 'cancelled'; status: string; sizeMatched: string }
  | { kind: 'timeout'; status: string; sizeMatched: string };

// Poll getOrder until the order leaves LIVE state or we hit the timeout.
// Mirrors the server-side pollOrderResolution helper in clob.ts so the
// classification is consistent across paths.
export async function pollOrderFromBrowser(
  client: ClobClient,
  orderId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<BrowserOrderResolution> {
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  let lastSizeMatched = '0';

  while (Date.now() < deadline) {
    try {
      const order = (await client.getOrder(orderId)) as
        | { status?: string; size_matched?: string }
        | null
        | undefined;
      if (order) {
        lastStatus = (order.status ?? '').toUpperCase();
        lastSizeMatched = order.size_matched ?? '0';
        if (parseFloat(lastSizeMatched) > 0 || lastStatus === 'MATCHED') {
          return { kind: 'matched', sizeMatched: lastSizeMatched, status: lastStatus };
        }
        if (
          lastStatus === 'CANCELED' ||
          lastStatus === 'CANCELLED' ||
          lastStatus === 'UNMATCHED' ||
          lastStatus === 'KILLED'
        ) {
          return { kind: 'cancelled', status: lastStatus, sizeMatched: lastSizeMatched };
        }
      }
    } catch (err) {
      // 404 means Polymarket dropped the order, treat as cancelled.
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|not.*found/i.test(msg)) {
        return { kind: 'cancelled', status: 'NOT_FOUND', sizeMatched: '0' };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { kind: 'timeout', status: lastStatus, sizeMatched: lastSizeMatched };
}

/**
 * Tells Polymarket's CLOB to re-read this user's balances/allowances after
 * we fund or approve from inside the deposit wallet. Without this, the
 * matcher's cached view says zero buying power and rejects every order
 * with insufficient-balance. Must hit `signature_type=3` for POLY_1271.
 */
export async function syncDepositWalletBalance(
  client: ClobClient,
): Promise<void> {
  // updateBalanceAllowance is implemented on the V2 client; no params means
  // refresh the collateral side by default. The SDK signs the GET with the
  // L2 HMAC headers it already cached.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).updateBalanceAllowance({ asset_type: 'COLLATERAL' });
  } catch (err) {
    // Best-effort: a stale cache produces a fixable rejection later, not a
    // silent failure. Log and continue.
    console.warn('[clob-browser] balance sync failed', err);
  }
}
