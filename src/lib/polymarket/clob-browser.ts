// Browser-side Polymarket CLOB client.
//
// Why this exists: Polymarket geoblocks 33 countries on `POST /order`,
// including the US (where Vercel's Hobby plan pins our Node functions to
// `iad1`). Doing the submit from the user's own browser sidesteps the block
// since Polymarket sees the user's residential IP instead of our function's.
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
  type ApiKeyCreds,
  type SignedOrder,
} from '@polymarket/clob-client';
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

// Builds a Polymarket ClobClient bound to the connected wallet's signer.
// On first call per EOA, prompts the user to sign Polymarket's API-key
// derivation challenge (one extra MetaMask popup). Subsequent calls reuse
// the cached credentials.
export async function getOrCreatePolymarketClient(
  ethereum: EthereumProvider,
  address: string,
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
    // The SDK's `_signer` accepts ethers v5 Signers via duck-typed
    // `_signTypedData`. The any-cast keeps TS happy across the SDK's
    // viem/ethers union signer type.
    const bootstrap = new ClobClient(
      HOST,
      CHAIN_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signer as any,
    );
    creds = await bootstrap.createOrDeriveApiKey();
    saveCachedCreds(address, creds);
  }

  return new ClobClient(
    HOST,
    CHAIN_ID,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer as any,
    creds,
  );
}

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
