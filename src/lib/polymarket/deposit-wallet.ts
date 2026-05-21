// Polymarket V2 deposit wallet helpers.
//
// V2 retired the public EOA path: orders are rejected with "maker address not
// allowed, please use the deposit wallet flow." Every user gets a per-EOA
// smart contract wallet (ERC-1967 minimal proxy, CREATE2-deterministic from
// the EOA + factory + implementation). The wallet holds pUSD on-chain and
// validates orders via ERC-1271. The EOA is the only signer; Polymarket
// custodies nothing.
//
// Two surfaces here:
//   - Pure helpers that just derive addresses + read deployment state. Safe
//     to call from anywhere (Next.js server routes, scripts, browser).
//   - Relayer wrappers that need the user's signer (browser-only). They
//     delegate to @polymarket/builder-relayer-client's RelayClient.

import { providers } from 'ethers';
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type PublicClient,
} from 'viem';
import { polygon } from 'viem/chains';
import {
  RelayClient,
  deriveDepositWallet,
  type DepositWalletCall,
} from '@polymarket/builder-relayer-client';
import {
  CONDITIONAL_TOKENS,
  DEPOSIT_WALLET_FACTORY,
  DEPOSIT_WALLET_IMPLEMENTATION,
  POLYGON_CHAIN_ID,
  POLYMARKET_RELAYER_URL,
  PUSD_ADDRESS,
} from './contracts';
import { getRelayerBuilderConfig } from './builder-config';
import { env } from '../env';

const MAX_UINT256 =
  BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const CTF_ABI = parseAbi([
  'function setApprovalForAll(address operator, bool approved)',
]);

/** Calldata for pUSD.approve(spender, MAX_UINT256). */
export function encodePusdApproveCall(spender: string): DepositWalletCall {
  return {
    target: PUSD_ADDRESS,
    value: '0',
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender as `0x${string}`, MAX_UINT256],
    }),
  };
}

/** Calldata for CTF.setApprovalForAll(operator, true). SELL prerequisite. */
export function encodeCtfApproveAllCall(operator: string): DepositWalletCall {
  return {
    target: CONDITIONAL_TOKENS,
    value: '0',
    data: encodeFunctionData({
      abi: CTF_ABI,
      functionName: 'setApprovalForAll',
      args: [operator as `0x${string}`, true],
    }),
  };
}

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

/**
 * Pure CREATE2 derivation — mirrors the relayer SDK's `deriveDepositWallet`.
 * No RPC call. Returns a checksummed 0x… address.
 */
export function deriveDepositWalletAddress(ownerEoa: string): `0x${string}` {
  return deriveDepositWallet(
    ownerEoa,
    DEPOSIT_WALLET_FACTORY,
    DEPOSIT_WALLET_IMPLEMENTATION,
  ) as `0x${string}`;
}

// ---- Server-side deployment-status read ----

function rpcUrls(): string[] {
  return [
    env.POLYGON_RPC_URL,
    'https://polygon-rpc.com',
    'https://polygon-mainnet.public.blastapi.io',
    'https://rpc.ankr.com/polygon',
    'https://polygon.drpc.org',
  ].filter((u): u is string => typeof u === 'string' && u.length > 0);
}

const clientCache = new Map<string, PublicClient>();
function clientFor(url: string): PublicClient {
  let c = clientCache.get(url);
  if (!c) {
    c = createPublicClient({
      chain: polygon,
      transport: http(url, { timeout: 4000 }),
    });
    clientCache.set(url, c);
  }
  return c;
}

/**
 * Multi-RPC `getCode` probe — returns `true` if there's any contract bytecode
 * deployed at the derived deposit-wallet address. Throws on all-RPCs-failed.
 */
export async function isDepositWalletDeployed(
  ownerEoa: string,
): Promise<boolean> {
  const wallet = deriveDepositWalletAddress(ownerEoa);
  let lastErr: unknown;
  for (const url of rpcUrls()) {
    try {
      const code = await clientFor(url).getCode({ address: wallet });
      return code !== undefined && code !== '0x';
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('isDepositWalletDeployed: no RPCs available');
}

// ---- Browser relayer wrappers ----

function getBrowserSigner(ethereum: EthereumProvider, address: string) {
  const provider = new providers.Web3Provider(
    ethereum as unknown as providers.ExternalProvider,
    { chainId: POLYGON_CHAIN_ID, name: 'matic' },
  );
  return provider.getSigner(address);
}

/**
 * RelayClient bound to the connected EOA and authenticated as zer0's builder.
 *
 * Polymarket's relayer rejects unauthenticated `/submit` calls with 401, so
 * we have to attach builder headers on every request — including
 * `WALLET_CREATE` (deploy) and `WALLET` (executeBatch). The SDK calls
 * `builderConfig.generateBuilderHeaders(method, path, body)` for us; our
 * shim (`RelayerApiKeyBuilderConfig`) returns the simpler
 * `RELAYER_API_KEY`/`RELAYER_API_KEY_ADDRESS` pair instead of the older
 * HMAC trio.
 *
 * EIP-712 signing for the per-user batch payload still happens in the
 * browser via the user's wallet — builder auth and user signature are
 * independent.
 */
export async function getBrowserRelayClient(
  ethereum: EthereumProvider,
  address: string,
): Promise<RelayClient> {
  const signer = getBrowserSigner(ethereum, address);
  const builderConfig = getRelayerBuilderConfig();
  return new RelayClient(
    POLYMARKET_RELAYER_URL,
    POLYGON_CHAIN_ID,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer as any,
    builderConfig,
  );
}

/**
 * Submit the WALLET_CREATE request to Polymarket's relayer; await mining.
 * No user popup — the relayer pays gas and there's no signature on the
 * create payload. Idempotent: if the wallet's already deployed, the relayer
 * still returns a confirmed tx.
 */
export async function deployDepositWalletFromBrowser(
  ethereum: EthereumProvider,
  address: string,
): Promise<void> {
  const relayer = await getBrowserRelayClient(ethereum, address);
  const response = await relayer.deployDepositWallet();
  await response.wait();
}

/**
 * Execute a batch of calls on the user's deposit wallet via the relayer.
 * One EIP-712 popup (the user signs the Batch typed-data). We use this for
 * the one-time pUSD.approve(V2Exchange) that has to come FROM the wallet —
 * the EOA can't approve on the wallet's behalf since the wallet is what
 * holds the pUSD.
 */
export async function executeDepositWalletBatchFromBrowser(
  ethereum: EthereumProvider,
  ownerAddress: string,
  depositWallet: string,
  calls: DepositWalletCall[],
  deadlineSeconds = 600,
): Promise<void> {
  const relayer = await getBrowserRelayClient(ethereum, ownerAddress);
  const deadline = Math.floor(Date.now() / 1000 + deadlineSeconds).toString();
  const response = await relayer.executeDepositWalletBatch(
    calls,
    depositWallet,
    deadline,
  );
  await response.wait();
}
