// Browser-side helpers for the Polymarket EOA setup flow.
//
// Two on-chain txs are needed before a user's first trade:
//   1. USDC.e.approve(exchange, MAX_UINT256) — collateral for BUYs.
//   2. CTF.setApprovalForAll(exchange, true) — only required for SELLs,
//      so the user can transfer their share tokens at fill time.
//
// We use viem to encode the calldata (deterministic, no runtime dependency
// on a wallet's signer abstraction) and send via the injected EIP-1193
// provider (`window.ethereum`) so it works with any wallet.

import { encodeFunctionData, parseAbi } from 'viem';
import {
  CONDITIONAL_TOKENS,
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

export async function sendApproveUsdc(
  ethereum: EthereumProvider,
  from: string,
  spender: string,
): Promise<string> {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender as `0x${string}`, BigInt(MAX_UINT256)],
  });
  return sendTx(ethereum, from, USDC_E_ADDRESS, data);
}

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
