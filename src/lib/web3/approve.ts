// Browser-side helpers for the Polymarket V2 deposit-wallet setup flow.
//
// EOA-signed txs (run before the order sign):
//   1. USDC.e.approve(Onramp, MAX_UINT256) — gives the CollateralOnramp
//      permission to pull USDC.e for wrapping into pUSD.
//   2. Onramp.wrap(USDC.e, depositWallet, amount) — converts USDC.e → pUSD
//      INTO THE DEPOSIT WALLET (not the EOA). V2 collateral lives in the
//      wallet; pUSD held by the EOA doesn't count as buying power.
//
// Relayer-signed (no user popup, Polymarket pays gas, see deposit-wallet.ts):
//   3. DepositWalletFactory deploys the user's wallet (one-time).
//   4. The wallet runs pUSD.approve(V2Exchange, MAX_UINT256) via
//      executeDepositWalletBatch (because the approval has to come FROM the
//      wallet — that's where the pUSD sits).
//   5. For SELL only: the wallet runs CTF.setApprovalForAll(V2Exchange, true)
//      via the same batch path.
//
// We use viem to encode the calldata (deterministic, no runtime dependency
// on a wallet's signer abstraction) and send via the injected EIP-1193
// provider (`window.ethereum`) so it works with any wallet.

import { encodeFunctionData, parseAbi } from 'viem';
import { USDC_E_ADDRESS } from '../polymarket/contracts';

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

const MAX_UINT256 =
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
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

/**
 * Wrap USDC.e into pUSD via the Onramp. Amount is in 6-decimal base units.
 * The `to` parameter is where the pUSD lands — for V2 this MUST be the
 * user's deposit wallet, not the EOA. V2 reads collateral state only from
 * deposit wallets.
 */
export async function sendWrapUsdc(
  ethereum: EthereumProvider,
  from: string,
  onramp: string,
  to: string,
  amount: bigint,
): Promise<string> {
  const data = encodeFunctionData({
    abi: ONRAMP_ABI,
    functionName: 'wrap',
    args: [USDC_E_ADDRESS as `0x${string}`, to as `0x${string}`, amount],
  });
  return sendTx(ethereum, from, onramp, data);
}

// pUSD.approve and CTF.setApprovalForAll no longer happen as EOA-signed txs
// in V2 — they're issued from inside the deposit wallet through Polymarket's
// relayer; the calldata builders live in deposit-wallet.ts.

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
