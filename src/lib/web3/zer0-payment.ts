// On-chain verification of a $ZER0 pay-per-sim transfer on Base.
//
// The product flow is: user signs an ERC-20 transfer of the per-sim price to
// the sink (treasury or burn) from their own wallet; we verify it landed before
// firing the sim. We never custody funds — the bot/app only reads the chain.
//
// Verification is intentionally strict: the tx must be mined + successful, and
// the sum of Transfer(value) logs emitted by the $ZER0 contract whose `to` is
// the configured sink (and, when known, whose `from` is the payer) must be at
// least the quoted amount. Reading logs (not just the tx input) means a
// transfer routed through a wallet's batch/relayer contract still counts.

import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  parseUnits,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { env } from '../env';

const ERC20_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/** Exported so the WC pay flow encodes the same `transfer(...)` calldata. */
export const ZER0_ERC20_ABI = ERC20_ABI;

function publicClient() {
  return createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL) });
}

/** Read the $ZER0 token's decimals from Base (cached per process). */
let decimalsCache: number | undefined;
export async function getZer0Decimals(): Promise<number> {
  if (decimalsCache !== undefined) return decimalsCache;
  const d = await publicClient().readContract({
    address: getAddress(env.ZER0_TOKEN_ADDRESS),
    abi: ERC20_ABI,
    functionName: 'decimals',
  });
  decimalsCache = Number(d);
  return decimalsCache;
}

/** Per-sim price (from env) in base units, using the token's on-chain decimals. */
export async function quotedSimAmount(): Promise<bigint> {
  const decimals = await getZer0Decimals();
  return parseUnits(env.ZER0_SIM_PRICE, decimals);
}

export interface VerifyPaymentArgs {
  txHash: string;
  /** The sink the transfer must land in (pending_sims.pay_to_address). */
  expectedTo: string;
  /** Minimum total transferred, in base units. */
  expectedAmount: bigint;
  /** When known, require the transfer to originate from this address. */
  expectedFrom?: string | null;
  /** Override the token contract (defaults to ZER0_TOKEN_ADDRESS). */
  tokenAddress?: string;
  /** How long to wait for the tx to be mined. Default 180s. */
  waitMs?: number;
}

export interface VerifyPaymentResult {
  ok: boolean;
  reason?:
    | 'receipt_not_found'
    | 'tx_reverted'
    | 'amount_too_low'
    | 'no_matching_transfer';
  /** Total matched amount transferred to the sink, in base units. */
  amount?: bigint;
}

export async function verifyZer0Payment(
  args: VerifyPaymentArgs,
): Promise<VerifyPaymentResult> {
  const client = publicClient();
  const token = getAddress(args.tokenAddress ?? env.ZER0_TOKEN_ADDRESS);
  const sink = getAddress(args.expectedTo);
  const from = args.expectedFrom ? getAddress(args.expectedFrom) : null;

  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash: args.txHash as Hex,
      timeout: args.waitMs ?? 180_000,
      confirmations: 1,
    });
  } catch {
    return { ok: false, reason: 'receipt_not_found' };
  }
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_reverted' };

  let total = BigInt(0);
  let sawTransfer = false;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== token) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: ERC20_ABI,
        data: log.data,
        topics: log.topics,
      });
    } catch {
      continue; // not a Transfer log
    }
    if (decoded.eventName !== 'Transfer') continue;
    const a = decoded.args as unknown as {
      from: string;
      to: string;
      value: bigint;
    };
    if (getAddress(a.to) !== sink) continue;
    if (from && getAddress(a.from) !== from) continue;
    sawTransfer = true;
    total += a.value;
  }

  if (!sawTransfer) return { ok: false, reason: 'no_matching_transfer' };
  if (total < args.expectedAmount) {
    return { ok: false, reason: 'amount_too_low', amount: total };
  }
  return { ok: true, amount: total };
}
