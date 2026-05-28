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

/** The Transfer event, used for indexed `getLogs` filtering in the scanner. */
const TRANSFER_EVENT = ERC20_ABI[0];

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

/** Current Base block height — the durable verifier's scan lower bound. */
export async function currentBaseBlock(): Promise<bigint> {
  return publicClient().getBlockNumber();
}

export interface ScanForSimPaymentArgs {
  /** Payer EOA — REQUIRED so concurrent payers to the same sink don't cross-attribute. */
  from: string;
  /** The sink the transfer must land in. */
  to: string;
  /** Minimum transferred value, in base units. */
  minAmount: bigint;
  /** Block to scan from (the chain tip captured when Pay was tapped). */
  fromBlock: bigint;
  /** Block to scan to (defaults to the current chain tip). */
  toBlock?: bigint;
  /** Max blocks per getLogs call (defaults to env.BASE_LOG_SCAN_CHUNK). */
  maxRange?: bigint;
  /** Override the token contract (defaults to ZER0_TOKEN_ADDRESS). */
  tokenAddress?: string;
  /**
   * Tx hashes already funding another sim — skip them so a second concurrent
   * invoice from the same payer advances to its own transfer. Case-insensitive.
   */
  excludeTxHashes?: readonly string[];
}

export interface ScanForSimPaymentMatch {
  txHash: string;
  value: bigint;
}

/**
 * Scan Base for the payer's $ZER0 Transfer to the sink. Both `from` and `to` are
 * indexed on the Transfer event, so getLogs filters server-side — cheap, and the
 * `from` filter is what keeps concurrent same-sink payers from cross-attributing.
 *
 * Walks [fromBlock, toBlock] in `maxRange`-sized chunks because free RPC tiers
 * cap the getLogs block range (QuickNode Discover 5, Alchemy free 10). Returns
 * the first log whose value clears `minAmount` (one valid payment is enough), or
 * null if none in range yet.
 */
export async function scanForSimPayment(
  args: ScanForSimPaymentArgs,
): Promise<ScanForSimPaymentMatch | null> {
  const client = publicClient();
  const token = getAddress(args.tokenAddress ?? env.ZER0_TOKEN_ADDRESS);
  const from = getAddress(args.from);
  const to = getAddress(args.to);
  const tip = args.toBlock ?? (await client.getBlockNumber());
  const chunk = args.maxRange ?? BigInt(env.BASE_LOG_SCAN_CHUNK);
  const one = BigInt(1);
  const exclude = new Set(
    (args.excludeTxHashes ?? []).map((h) => h.toLowerCase()),
  );

  for (let start = args.fromBlock; start <= tip; start = start + chunk) {
    let end = start + chunk - one;
    if (end > tip) end = tip;
    const logs = await client.getLogs({
      address: token,
      event: TRANSFER_EVENT,
      args: { from, to },
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      const value = (log.args as { value?: bigint }).value;
      if (value === undefined || value < args.minAmount) continue;
      if (!log.transactionHash) continue;
      if (exclude.has(log.transactionHash.toLowerCase())) continue;
      return { txHash: log.transactionHash, value };
    }
  }
  return null;
}
