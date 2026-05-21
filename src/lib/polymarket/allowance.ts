// Server-side allowance / approval reader for Polymarket trading.
//
// USDC.e allowance and ConditionalTokens setApprovalForAll status are read
// straight from Polygon mainnet via public RPCs. We try several endpoints
// in order so a single rate-limiting RPC (polygon-rpc.com aggressively
// throttles serverless IP ranges) doesn't take the preflight down.

import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { polygon } from 'viem/chains';
import { env } from '../env';
import {
  CONDITIONAL_TOKENS,
  USDC_E_ADDRESS,
} from './contracts';

const USDC_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
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

export async function getCollateralAllowance(
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  return withFallback(async (client) => {
    const result = await client.readContract({
      address: USDC_E_ADDRESS,
      abi: USDC_ABI,
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
