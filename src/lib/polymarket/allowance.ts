// Server-side allowance / approval reader for Polymarket trading.
//
// USDC.e allowance and ConditionalTokens setApprovalForAll status are read
// straight from Polygon mainnet via a public RPC. No private key required;
// these are eth_call reads only.

import { createPublicClient, http, parseAbi } from 'viem';
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

let cachedClient: ReturnType<typeof createPublicClient> | null = null;

function getPublicClient() {
  if (cachedClient) return cachedClient;
  cachedClient = createPublicClient({
    chain: polygon,
    transport: http(env.POLYGON_RPC_URL),
  });
  return cachedClient;
}

export async function getCollateralAllowance(
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  const client = getPublicClient();
  const result = await client.readContract({
    address: USDC_E_ADDRESS,
    abi: USDC_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  });
  return result as bigint;
}

export async function isCtfApprovedForAll(
  owner: `0x${string}`,
  operator: `0x${string}`,
): Promise<boolean> {
  const client = getPublicClient();
  const result = await client.readContract({
    address: CONDITIONAL_TOKENS,
    abi: CTF_ABI,
    functionName: 'isApprovedForAll',
    args: [owner, operator],
  });
  return result as boolean;
}
