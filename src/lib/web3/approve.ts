// Browser-side helpers for the Polymarket V2 EOA setup flow.
//
// Three on-chain txs may be needed before a user's first trade:
//   1. USDC.e.approve(Onramp, MAX_UINT256) — gives the CollateralOnramp
//      permission to pull USDC.e for wrapping into pUSD.
//   2. Onramp.wrap(USDC.e, user, amount) — converts USDC.e → pUSD.
//   3. pUSD.approve(V2Exchange, MAX_UINT256) — collateral for BUYs/SELLs.
// Plus, for SELL only:
//   4. CTF.setApprovalForAll(V2Exchange, true) — so the user can transfer
//      their share tokens at fill time.
//
// We use viem to encode the calldata (deterministic, no runtime dependency
// on a wallet's signer abstraction) and send via the injected EIP-1193
// provider (`window.ethereum`) so it works with any wallet.

import { encodeFunctionData, parseAbi } from 'viem';
import {
  CONDITIONAL_TOKENS,
  PUSD_ADDRESS,
  USDC_E_ADDRESS,
} from '../polymarket/contracts';

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

const MAX_UINT256 =
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const CTF_ABI = parseAbi([
  'function setApprovalForAll(address operator, bool approved)',
]);

const ONRAMP_ABI = parseAbi([
  'function wrap(address asset, address to, uint256 amount)',
]);

async function sendTx(
  ethereum: EthereumProvider,
  from: string,
  to: string,
  data: `0x${string}`,
): Promise<string> {
  const txHash = (await ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data }],
  })) as string;
  return txHash;
}

/** Approve the CollateralOnramp to spend the user's USDC.e (for wrapping). */
export async function sendApproveUsdcForOnramp(
  ethereum: EthereumProvider,
  from: string,
  onramp: string,
): Promise<string> {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [onramp as `0x${string}`, BigInt(MAX_UINT256)],
  });
  return sendTx(ethereum, from, USDC_E_ADDRESS, data);
}

/** Wrap USDC.e into pUSD via the Onramp. Amount is in 6-decimal base units. */
export async function sendWrapUsdc(
  ethereum: EthereumProvider,
  from: string,
  onramp: string,
  amount: bigint,
): Promise<string> {
  const data = encodeFunctionData({
    abi: ONRAMP_ABI,
    functionName: 'wrap',
    args: [USDC_E_ADDRESS as `0x${string}`, from as `0x${string}`, amount],
  });
  return sendTx(ethereum, from, onramp, data);
}

/** Approve the V2 Exchange to spend the user's pUSD. */
export async function sendApprovePusd(
  ethereum: EthereumProvider,
  from: string,
  spender: string,
): Promise<string> {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender as `0x${string}`, BigInt(MAX_UINT256)],
  });
  return sendTx(ethereum, from, PUSD_ADDRESS, data);
}

/** SELL-only: give the V2 Exchange operator rights on the user's CTF tokens. */
export async function sendSetApprovalForAllCtf(
  ethereum: EthereumProvider,
  from: string,
  spender: string,
): Promise<string> {
  const data = encodeFunctionData({
    abi: CTF_ABI,
    functionName: 'setApprovalForAll',
    args: [spender as `0x${string}`, true],
  });
  return sendTx(ethereum, from, CONDITIONAL_TOKENS, data);
}

export type ReceiptResult = {
  status: 'success' | 'reverted';
  blockNumber: string;
  transactionHash: string;
};

export async function waitForReceipt(
  ethereum: EthereumProvider,
  txHash: string,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<ReceiptResult> {
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const receipt = (await ethereum.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    })) as
      | { status: string; blockNumber: string; transactionHash: string }
      | null;

    if (receipt && receipt.blockNumber) {
      const status =
        receipt.status === '0x1'
          ? 'success'
          : receipt.status === '0x0'
            ? 'reverted'
            : 'success';
      return {
        status,
        blockNumber: receipt.blockNumber,
        transactionHash: receipt.transactionHash,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`tx ${txHash} not mined within ${timeoutMs}ms`);
}
