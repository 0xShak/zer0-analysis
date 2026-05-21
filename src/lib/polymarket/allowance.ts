// Server-side balance / allowance / approval reader for Polymarket V2.
//
// V2 trades against pUSD (an ERC-20 wrapping USDC.e via the CollateralOnramp).
// We read four things to drive the UI's first-trade setup:
//   - pUSD balance + pUSD allowance on the V2 Exchange (the actual trading
//     prerequisite)
//   - USDC.e balance + USDC.e allowance on the Onramp (so the UI can drive
//     the USDC.e → pUSD wrap if the user has USDC.e but no pUSD)
//   - CTF.isApprovedForAll on the V2 Exchange (only needed for SELLs)
//
// Reads go through a multi-RPC fallback so a single rate-limited public RPC
// doesn't take the preflight down.

import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { polygon } from 'viem/chains';
import { env } from '../env';
import {
  COLLATERAL_ONRAMP,
  CONDITIONAL_TOKENS,
  PUSD_ADDRESS,
  USDC_E_ADDRESS,
} from './contracts';

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);

const CTF_ABI = parseAbi([
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);

// Ordered list of RPCs to try. POLYGON_RPC_URL (env override) goes first;
// the rest are well-known free endpoints. Duplicates filtered, order
// preserved — the first that doesn't fail wins.
function getRpcUrls(): string[] {
  const candidates = [
    env.POLYGON_RPC_URL,
    'https://polygon-rpc.com',
    'https://polygon-mainnet.public.blastapi.io',
    'https://rpc.ankr.com/polygon',
    'https://polygon.drpc.org',
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of candidates) {
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
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

export class AllRpcsFailedError extends Error {
  constructor(public readonly attempts: { url: string; error: string }[]) {
    super(`all RPCs failed (${attempts.length} attempts)`);
    this.name = 'AllRpcsFailedError';
  }
}

async function withFallback<T>(
  read: (client: PublicClient) => Promise<T>,
): Promise<T> {
  const attempts: { url: string; error: string }[] = [];
  for (const url of getRpcUrls()) {
    try {
      return await read(clientFor(url));
    } catch (err) {
      attempts.push({
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw new AllRpcsFailedError(attempts);
}

export async function getPusdBalance(owner: `0x${string}`): Promise<bigint> {
  return withFallback(async (client) => {
    const result = await client.readContract({
      address: PUSD_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner],
    });
    return result as bigint;
  });
}

export async function getPusdAllowance(
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  return withFallback(async (client) => {
    const result = await client.readContract({
      address: PUSD_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, spender],
    });
    return result as bigint;
  });
}

export async function getUsdceBalance(owner: `0x${string}`): Promise<bigint> {
  return withFallback(async (client) => {
    const result = await client.readContract({
      address: USDC_E_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner],
    });
    return result as bigint;
  });
}

export async function getUsdceAllowance(
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  return withFallback(async (client) => {
    const result = await client.readContract({
      address: USDC_E_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, spender],
    });
    return result as bigint;
  });
}

export async function isCtfApprovedForAll(
  owner: `0x${string}`,
  operator: `0x${string}`,
): Promise<boolean> {
  return withFallback(async (client) => {
    const result = await client.readContract({
      address: CONDITIONAL_TOKENS,
      abi: CTF_ABI,
      functionName: 'isApprovedForAll',
      args: [owner, operator],
    });
    return result as boolean;
  });
}

export { COLLATERAL_ONRAMP };
