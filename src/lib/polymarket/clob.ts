// Polymarket CLOB client — non-custodial trade execution helpers.
//
// We DO NOT sign user orders. The relay key only authenticates Polymarket's
// HMAC API surface (createOrDeriveApiKey, postOrder). The user signs the
// EIP-712 typed-data payload we hand them.
//
// Flow (see zer0.md §8, prompt1 Day 5):
//   prepare → buildTypedData() → frontend signTypedData() → submit →
//   postSignedOrder() → CLOB.

import { Wallet } from 'ethers';
import {
  ClobClient,
  OrderType,
  type ApiKeyCreds,
  type EIP712TypedData,
  type SignedOrder,
} from '@polymarket/clob-client';
import {
  ROUNDING_CONFIG,
  buildOrderCreationArgs,
} from '@polymarket/clob-client/dist/order-builder/helpers.js';
import { ExchangeOrderBuilder } from '@polymarket/clob-client/dist/order-utils/exchange.order.builder.js';
import { getContractConfig } from '@polymarket/clob-client/dist/config.js';
import { generateOrderSalt } from '@polymarket/clob-client/dist/order-utils/utils.js';
import { env } from '../env';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

export type TickSize = '0.1' | '0.01' | '0.001' | '0.0001';
export type SignatureTypeNum = 0 | 1 | 2 | 3;

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

// Stub signer used only as a ctor-argument for ExchangeOrderBuilder during
// the prepare phase — buildOrderTypedData never reads from it. Letting this
// run without RELAY_PRIVATE_KEY means /api/trade/prepare works in local dev
// without a real Polygon key; /api/trade/submit still requires the real one.
let stubSigner: Wallet | null = null;
function getTypedDataStubSigner(): Wallet {
  if (stubSigner) return stubSigner;
  try {
    stubSigner = getRelaySigner();
    return stubSigner;
  } catch {
    // Deterministic, well-known throwaway key — never used to sign anything.
    stubSigner = new Wallet(
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    );
    return stubSigner;
  }
}

/**
 * Lazily build a ClobClient. The first call derives or creates the relay's
 * API credentials and stashes them in-memory.
 */
export async function getClobClient(): Promise<ClobClient> {
  if (cachedClient && cachedCreds) return cachedClient;
  const signer = getRelaySigner();
  // ethers v5 Wallet implements `_signTypedData`, matching the SDK's
  // `EthersSigner` shape. Cast to satisfy the SDK's union type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bootstrap = new ClobClient(HOST, CHAIN_ID, signer as any);
  cachedCreds = await bootstrap.createOrDeriveApiKey();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cachedClient = new ClobClient(HOST, CHAIN_ID, signer as any, cachedCreds);
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
  maker: string;
  taker?: string;
  feeRateBps?: number;
  signatureType: SignatureTypeNum;
  tickSize: TickSize;
  negRisk: boolean;
}

/**
 * Returns the unsigned EIP-712 typed-data payload the user must sign.
 *
 * We deliberately bypass ExchangeOrderBuilder.buildOrder() because it
 * verifies the order's `signer` equals the relay's address. In our flow the
 * signer IS the user — the relay never signs orders.
 */
export async function buildTypedData(args: BuildTypedDataArgs): Promise<EIP712TypedData> {
  const roundConfig = ROUNDING_CONFIG[args.tickSize];
  // buildOrderCreationArgs is a pure helper — `signer` is just a string field
  // on the resulting OrderData; it never touches a real signer here.
  const orderData = await buildOrderCreationArgs(
    args.maker,
    args.maker,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args.signatureType as any,
    {
      tokenID: args.tokenId,
      price: args.price,
      size: args.size,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      side: args.side as any,
      feeRateBps: args.feeRateBps ?? 0,
      taker: args.taker ?? '0x0000000000000000000000000000000000000000',
    },
    roundConfig,
  );

  const contractConfig = getContractConfig(CHAIN_ID);
  const exchangeAddress = args.negRisk
    ? contractConfig.negRiskExchange
    : contractConfig.exchange;

  // Constructor needs a signer to satisfy the type, but buildOrderTypedData
  // never invokes it. We never call buildSignedOrder / buildOrder.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = new ExchangeOrderBuilder(exchangeAddress, CHAIN_ID, getTypedDataStubSigner() as any);

  const order = {
    salt: generateOrderSalt(),
    maker: orderData.maker,
    signer: orderData.signer ?? orderData.maker,
    taker: orderData.taker,
    tokenId: orderData.tokenId,
    makerAmount: orderData.makerAmount,
    takerAmount: orderData.takerAmount,
    expiration: orderData.expiration ?? '0',
    nonce: orderData.nonce,
    feeRateBps: orderData.feeRateBps,
    side: orderData.side,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signatureType: args.signatureType as any,
  };

  return builder.buildOrderTypedData(order);
}

/**
 * Forward a user-signed order to Polymarket CLOB.
 * Caller is responsible for mapping any thrown error to 422 / 503.
 */
export async function postSignedOrder(
  signedOrder: SignedOrder,
  orderType: OrderType = OrderType.GTC,
): Promise<unknown> {
  const client = await getClobClient();
  return client.postOrder(signedOrder, orderType);
}

export { OrderType };

// ---- Back-compat exports kept for old callers (existing route stubs) ----
export interface OrderArgs {
  tokenID: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  feeRateBps?: number;
  maker: string;
  taker?: string;
}
/** @deprecated Use buildTypedData() with explicit market meta instead. */
export async function buildOrderTypedData(
  args: OrderArgs,
  opts?: { tickSize?: TickSize; negRisk?: boolean; signatureType?: SignatureTypeNum },
): Promise<EIP712TypedData> {
  return buildTypedData({
    tokenId: args.tokenID,
    price: args.price,
    size: args.size,
    side: args.side,
    maker: args.maker,
    taker: args.taker,
    feeRateBps: args.feeRateBps,
    signatureType: opts?.signatureType ?? 0,
    tickSize: opts?.tickSize ?? '0.01',
    negRisk: opts?.negRisk ?? false,
  });
}
