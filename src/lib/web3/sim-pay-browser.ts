// Browser-side $ZER0 pay-per-sim on Base (eip155:8453 / 0x2105).
//
// Mirrors the Telegram wc/pay.ts flow, but for an injected EIP-1193 wallet
// (window.ethereum) instead of WalletConnect: switch the wallet to Base,
// send an ERC-20 transfer of the quoted amount to the sink (the 0x…dEaD burn
// address by default), and wait for it to mine. The caller then POSTs the
// tx hash to /api/sim/verify, which re-verifies the transfer server-side
// before firing the run — so a wallet that lies about success can't sneak a
// free sim through.

import { encodeFunctionData, parseAbi } from 'viem';
import { waitForReceipt } from './approve';

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

// Base mainnet chainId, hex-encoded for wallet RPC calls.
const BASE_HEX = '0x2105';

const TRANSFER_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/** Make sure the injected wallet is on Base, adding the chain if it's unknown. */
export async function switchToBase(ethereum: EthereumProvider): Promise<void> {
  const current = (
    (await ethereum.request({ method: 'eth_chainId' })) as string
  ).toLowerCase();
  if (current === BASE_HEX) return;
  try {
    await ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_HEX }],
    });
  } catch (err) {
    // 4902 = chain not added to the wallet yet.
    if ((err as { code?: number })?.code === 4902) {
      await ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: BASE_HEX,
            chainName: 'Base',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://mainnet.base.org'],
            blockExplorerUrls: ['https://basescan.org'],
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

export interface PayForSimArgs {
  ethereum: EthereumProvider;
  from: string;
  /** $ZER0 token contract (quote.tokenAddress). */
  tokenAddress: string;
  /** Burn/treasury sink the fee lands in (quote.sinkAddress). */
  sinkAddress: string;
  /** Exact transfer amount in base units (quote.amountBaseUnits). */
  amountBaseUnits: string;
}

/**
 * Send the per-sim $ZER0 transfer on Base and wait for it to mine. Returns the
 * tx hash for /api/sim/verify. Throws if the wallet rejects, the send fails,
 * or the tx reverts.
 */
export async function payForSim(args: PayForSimArgs): Promise<string> {
  await switchToBase(args.ethereum);

  const data = encodeFunctionData({
    abi: TRANSFER_ABI,
    functionName: 'transfer',
    args: [args.sinkAddress as `0x${string}`, BigInt(args.amountBaseUnits)],
  });

  const txHash = (await args.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from: args.from, to: args.tokenAddress, data }],
  })) as string;

  const receipt = await waitForReceipt(args.ethereum, txHash, {
    timeoutMs: 120_000,
  });
  if (receipt.status !== 'success') {
    throw new Error('payment transaction reverted');
  }
  return txHash;
}
