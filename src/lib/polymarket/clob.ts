// Polymarket CLOB V2 client — non-custodial trade execution helpers.
//
// We DO NOT sign user orders. The relay key only authenticates Polymarket's
// HMAC API surface (createOrDeriveApiKey for server-side reads). The user
// signs the EIP-712 typed-data payload we hand them in the browser.
//
// Flow (post-V2 migration, 2026-04-28):
//   prepare → buildTypedData() → frontend signTypedData() →
//   browser ClobClient.postOrder → CLOB V2.
//
// We inline the V2 EIP-712 domain + struct constants instead of importing
// the SDK's internal `ExchangeOrderBuilderV2` because the V2 SDK only
// exposes `.` as a package export (no subpath imports allowed). The SDK's
// `OrderBuilder` enforces `signer === connectedWalletAddress`, which we
// can't satisfy here — the relay key is the connected signer but the user
// is the order's signer. Inlining is short and stays version-pinned to
// what the contract expects.

import { Wallet } from 'ethers';
import {
  ClobClient,
  OrderType,
  type ApiKeyCreds,
} from '@polymarket/clob-client-v2';
import { parseUnits } from 'viem';
import { env } from '../env';
import { exchangeForMarket } from './contracts';
import {
  BYTES32_ZERO,
  COLLATERAL_DECIMALS,
  EIP712_DOMAIN_STRUCT,
  POLYGON_CHAIN_ID,
  TYPED_DATA_SIGN_STRUCT,
  V2_DOMAIN_NAME,
  V2_DOMAIN_VERSION,
  V2_ORDER_STRUCT,
  ZERO_ADDRESS,
  type SignatureTypeNum,
  type TickSize,
} from './types-v2';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = POLYGON_CHAIN_ID; // Polygon mainnet

// The deposit wallets the bot builds TypedDataSign for. The `name`/`version`
// fields go inside the wrapper, alongside the deposit-wallet address as
// `verifyingContract`. Salt is fixed at bytes32(0) — Polymarket doesn't use
// a per-domain salt for deposit wallets.
const DEPOSIT_WALLET_DOMAIN_NAME = 'DepositWallet';
const DEPOSIT_WALLET_DOMAIN_VERSION = '1';

export type { TickSize, SignatureTypeNum } from './types-v2';

interface RoundConfig {
  price: number;
  size: number;
  amount: number;
}

// V2 SDK's rounding lookup, mirrored. Without it the maker/taker amounts
// drift from what the matcher accepts (orderToJsonV2 expects strings that
// fit the contract's uint256 precision).
const ROUNDING_CONFIG: Record<TickSize, RoundConfig> = {
  '0.1': { price: 1, size: 2, amount: 3 },
  '0.01': { price: 2, size: 2, amount: 4 },
  '0.001': { price: 3, size: 2, amount: 5 },
  '0.0001': { price: 4, size: 2, amount: 6 },
};

function decimalPlaces(n: number): number {
  const s = n.toString();
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}
function roundNormal(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function roundDown(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(n * f) / f;
}
function roundUp(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.ceil(n * f) / f;
}

// Mirrors V2 SDK's `getOrderRawAmounts`: BUY rounds taker (shares) down,
// SELL rounds maker (shares) down; the other side is derived by *price
// then snapped to the tick's amount precision.
function getOrderRawAmounts(
  side: 'BUY' | 'SELL',
  size: number,
  price: number,
  cfg: RoundConfig,
): { rawMakerAmt: number; rawTakerAmt: number } {
  const rawPrice = roundNormal(price, cfg.price);
  if (side === 'BUY') {
    const rawTakerAmt = roundDown(size, cfg.size);
    let rawMakerAmt = rawTakerAmt * rawPrice;
    if (decimalPlaces(rawMakerAmt) > cfg.amount) {
      rawMakerAmt = roundUp(rawMakerAmt, cfg.amount + 4);
      if (decimalPlaces(rawMakerAmt) > cfg.amount) {
        rawMakerAmt = roundDown(rawMakerAmt, cfg.amount);
      }
    }
    return { rawMakerAmt, rawTakerAmt };
  }
  const rawMakerAmt = roundDown(size, cfg.size);
  let rawTakerAmt = rawMakerAmt * rawPrice;
  if (decimalPlaces(rawTakerAmt) > cfg.amount) {
    rawTakerAmt = roundUp(rawTakerAmt, cfg.amount + 4);
    if (decimalPlaces(rawTakerAmt) > cfg.amount) {
      rawTakerAmt = roundDown(rawTakerAmt, cfg.amount);
    }
  }
  return { rawMakerAmt, rawTakerAmt };
}

function generateOrderSalt(): string {
  return `${Math.round(Math.random() * Date.now())}`;
}

let cachedClient: ClobClient | null = null;
let cachedCreds: ApiKeyCreds | null = null;
let cachedSigner: Wallet | null = null;

interface MarketCacheEntry {
  negRisk: boolean;
  tickSize: TickSize;
  question: string;
  expiresAt: number;
}
const MARKET_TTL_MS = 5 * 60 * 1000;
const marketCache = new Map<string, MarketCacheEntry>();

function getRelaySigner(): Wallet {
  if (cachedSigner) return cachedSigner;
  cachedSigner = new Wallet(env.RELAY_PRIVATE_KEY);
  return cachedSigner;
}

/**
 * Lazily build a V2 ClobClient. The first call derives or creates the relay's
 * API credentials and stashes them in-memory. Server-side reads only —
 * `getMarket`, `getOrderBook`, `getOrder` for polling. Trade submission
 * happens from the browser.
 */
export async function getClobClient(): Promise<ClobClient> {
  if (cachedClient && cachedCreds) return cachedClient;
  const signer = getRelaySigner();
  // ethers v5 Wallet implements `_signTypedData`, matching the SDK's
  // EthersSigner shape. Cast to satisfy the SDK's viem|ethers union type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bootstrap = new ClobClient({ host: HOST, chain: CHAIN_ID, signer: signer as any });
  cachedCreds = await bootstrap.createOrDeriveApiKey();
  cachedClient = new ClobClient({
    host: HOST,
    chain: CHAIN_ID,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: signer as any,
    creds: cachedCreds,
  });
  return cachedClient;
}

/** Cached lookup of (negRisk, tickSize, question) for a condition_id. */
export async function getMarketMeta(conditionId: string): Promise<MarketCacheEntry> {
  const now = Date.now();
  const cached = marketCache.get(conditionId);
  if (cached && cached.expiresAt > now) return cached;

  const client = await getClobClient();
  const market = await client.getMarket(conditionId);
  const entry: MarketCacheEntry = {
    negRisk: Boolean(market?.neg_risk ?? market?.negRisk ?? false),
    tickSize: normaliseTickSize(market?.minimum_tick_size ?? market?.tick_size),
    question: typeof market?.question === 'string' ? market.question : '',
    expiresAt: now + MARKET_TTL_MS,
  };
  marketCache.set(conditionId, entry);
  return entry;
}

function normaliseTickSize(raw: unknown): TickSize {
  const s = typeof raw === 'number' ? raw.toString() : typeof raw === 'string' ? raw : '0.01';
  if (s === '0.1' || s === '0.01' || s === '0.001' || s === '0.0001') return s;
  return '0.01';
}

export interface BuildTypedDataArgs {
  tokenId: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  /** The on-chain account the matcher debits (proxy / safe / deposit wallet / EOA). */
  maker: string;
  /**
   * The address whose key actually signs. For type 1/2 (proxy/safe) this is
   * the EOA. For type 3 (deposit wallet) the spec sets signer === maker ===
   * the deposit wallet itself; ERC-7739 verifies the inner ECDSA against
   * the wallet's owner separately.
   */
  signer?: string;
  signatureType: SignatureTypeNum;
  tickSize: TickSize;
  negRisk: boolean;
  /** Optional GTD expiration (unix seconds). "0" = no expiry. */
  expiration?: number;
}

interface V2OrderTypedData {
  primaryType: 'Order';
  types: {
    EIP712Domain: ReadonlyArray<{ name: string; type: string }>;
    Order: ReadonlyArray<{ name: string; type: string }>;
  };
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  message: {
    salt: string;
    maker: string;
    signer: string;
    tokenId: string;
    makerAmount: string;
    takerAmount: string;
    timestamp: string;
    side: 0 | 1;
    signatureType: number;
    metadata: string;
    builder: string;
  };
}

interface V2TypedDataSign {
  primaryType: 'TypedDataSign';
  types: {
    EIP712Domain: ReadonlyArray<{ name: string; type: string }>;
    TypedDataSign: ReadonlyArray<{ name: string; type: string }>;
    Order: ReadonlyArray<{ name: string; type: string }>;
  };
  // Per the V2 SDK (exchangeOrderBuilderV2.js#buildOrderSignature) the outer
  // EIP-712 domain on the wire is the V2 EXCHANGE domain. The deposit
  // wallet's own (name "DepositWallet", v "1", verifyingContract = wallet
  // addr) is encoded as fields *inside* the TypedDataSign struct, not as
  // the EIP-712 domain. This matches ERC-7739 §"nested TypedDataSign".
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  message: {
    contents: V2OrderTypedData['message'];
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
    salt: string;
  };
}

export type V2TypedData = V2OrderTypedData | V2TypedDataSign;

// The wire-body shape (string side, includes taker/expiration). The browser
// merges the signature into this after `eth_signTypedData_v4` succeeds.
export interface V2OrderForWire {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: 'BUY' | 'SELL';
  signatureType: number;
  timestamp: string;
  expiration: string;
  metadata: string;
  builder: string;
}

export interface PreparedOrder {
  typedData: V2TypedData;
  order: V2OrderForWire;
}

/**
 * Returns:
 *   - `typedData`: the unsigned EIP-712 payload to feed `eth_signTypedData_v4`.
 *     `message.side` is numeric (0/1) because the EIP-712 hash treats `side`
 *     as `uint8`.
 *   - `order`: the wire-body order (string side, includes taker + expiration)
 *     for the browser to merge the signature into and POST.
 */
export async function buildTypedData(args: BuildTypedDataArgs): Promise<PreparedOrder> {
  const cfg = ROUNDING_CONFIG[args.tickSize];
  const { rawMakerAmt, rawTakerAmt } = getOrderRawAmounts(
    args.side,
    args.size,
    args.price,
    cfg,
  );
  const makerAmount = parseUnits(rawMakerAmt.toString(), COLLATERAL_DECIMALS).toString();
  const takerAmount = parseUnits(rawTakerAmt.toString(), COLLATERAL_DECIMALS).toString();

  const verifyingContract = exchangeForMarket(args.negRisk);
  const salt = generateOrderSalt();
  const timestamp = Date.now().toString();
  const expiration = args.expiration !== undefined ? args.expiration.toString() : '0';
  const sideNumeric: 0 | 1 = args.side === 'BUY' ? 0 : 1;

  // For type 1/2 (proxy/safe) the signer is the user's EOA. For type 3
  // (deposit wallet) the signed Order has maker === signer === wallet addr;
  // ERC-7739 verifies the inner ECDSA against the wallet's owner key off
  // to the side. Caller can override via args.signer for type 1/2.
  const signer =
    args.signatureType === 3 ? args.maker : (args.signer ?? args.maker);

  const orderMessage: V2OrderTypedData['message'] = {
    salt,
    maker: args.maker,
    signer,
    tokenId: args.tokenId,
    makerAmount,
    takerAmount,
    timestamp,
    side: sideNumeric,
    signatureType: args.signatureType,
    metadata: BYTES32_ZERO,
    builder: BYTES32_ZERO,
  };

  let typedData: V2TypedData;
  if (args.signatureType === 3) {
    // ERC-7739 nested TypedDataSign envelope. Per the V2 SDK
    // (exchangeOrderBuilderV2.buildOrderSignature) the OUTER EIP-712 domain
    // is the V2 EXCHANGE domain — that's what eth_signTypedData_v4 sees,
    // and that domain separator is what gets appended to the wrapped sig.
    // The deposit-wallet's own ("DepositWallet"/"1"/walletAddr) lives as
    // fields *inside* the TypedDataSign message, not as the EIP-712 domain.
    typedData = {
      primaryType: 'TypedDataSign',
      types: {
        EIP712Domain: EIP712_DOMAIN_STRUCT,
        TypedDataSign: TYPED_DATA_SIGN_STRUCT,
        Order: V2_ORDER_STRUCT,
      },
      domain: {
        name: V2_DOMAIN_NAME,
        version: V2_DOMAIN_VERSION,
        chainId: CHAIN_ID,
        verifyingContract,
      },
      message: {
        contents: orderMessage,
        name: DEPOSIT_WALLET_DOMAIN_NAME,
        version: DEPOSIT_WALLET_DOMAIN_VERSION,
        chainId: CHAIN_ID,
        verifyingContract: args.maker,
        salt: BYTES32_ZERO,
      },
    };
  } else {
    typedData = {
      primaryType: 'Order',
      types: {
        EIP712Domain: EIP712_DOMAIN_STRUCT,
        Order: V2_ORDER_STRUCT,
      },
      domain: {
        name: V2_DOMAIN_NAME,
        version: V2_DOMAIN_VERSION,
        chainId: CHAIN_ID,
        verifyingContract,
      },
      message: orderMessage,
    };
  }

  const order: V2OrderForWire = {
    salt,
    maker: args.maker,
    signer,
    taker: ZERO_ADDRESS,
    tokenId: args.tokenId,
    makerAmount,
    takerAmount,
    side: args.side,
    signatureType: args.signatureType,
    timestamp,
    expiration,
    metadata: BYTES32_ZERO,
    builder: BYTES32_ZERO,
  };

  return { typedData, order };
}

export type OrderResolution =
  | { kind: 'matched'; sizeMatched: string; status: string }
  | { kind: 'cancelled'; status: string; sizeMatched: string }
  | { kind: 'timeout'; status: string; sizeMatched: string }
  | { kind: 'unknown'; reason: string };

/**
 * Polymarket's `postOrder` response is just an acknowledgment — it doesn't
 * tell us if the matcher actually filled the order, because matching and
 * on-chain settlement happen asynchronously (1-6s after submit). To know
 * what really happened we poll `getOrder(orderID)` until the status leaves
 * "LIVE" or we time out.
 */
export async function pollOrderResolution(
  orderId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<OrderResolution> {
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const deadline = Date.now() + timeoutMs;
  const client = await getClobClient();

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
 * Fetch the price that crosses the spread on `tokenId` for the given side:
 *   - BUY  → best (lowest)  ask
 *   - SELL → best (highest) bid
 */
export async function getBestExecutionPrice(
  tokenId: string,
  side: 'BUY' | 'SELL',
): Promise<number | null> {
  const ctx = await getBookContext(tokenId, side);
  return ctx?.bestPrice ?? null;
}

export interface BookContext {
  bestPrice: number | null;
  minOrderSize: number;
}

export async function getBookContext(
  tokenId: string,
  side: 'BUY' | 'SELL',
): Promise<BookContext | null> {
  const client = await getClobClient();
  const book = await client.getOrderBook(tokenId);
  if (!book) return null;
  const levels = side === 'BUY' ? book.asks : book.bids;
  let best: number = side === 'BUY' ? Infinity : -Infinity;
  if (Array.isArray(levels)) {
    for (const lvl of levels) {
      const p = parseFloat(lvl?.price ?? '');
      if (!Number.isFinite(p)) continue;
      if (side === 'BUY' ? p < best : p > best) best = p;
    }
  }
  const bestPrice = Number.isFinite(best) ? best : null;
  const minOrderSize = parseFloat(book.min_order_size ?? '') || 0;
  return { bestPrice, minOrderSize };
}

export { OrderType };
