'use client';

import { useState } from 'react';

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export type TradeRecommendation = {
  id: string;
  market_question: string | null;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  conviction: number;
  rationale: string;
};

export function TradeCard({
  rec,
  userAddress,
}: {
  rec: TradeRecommendation;
  userAddress?: string;
}) {
  const [status, setStatus] = useState<
    'idle' | 'preparing' | 'signing' | 'submitting' | 'done' | 'error'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const [clobOrderId, setClobOrderId] = useState<string | null>(null);

  async function execute() {
    if (!userAddress) {
      setError('connect a wallet first');
      return;
    }
    const ethereum = typeof window !== 'undefined' ? window.ethereum : undefined;
    if (!ethereum) {
      setError('no injected wallet');
      return;
    }
    setError(null);
    setClobOrderId(null);
    try {
      // Polymarket is on Polygon (chainId 137 / 0x89). The EIP-712 domain we
      // ask the wallet to sign also encodes 137 — if the wallet is on a
      // different chain MetaMask rejects the sign request with -32603.
      const POLYGON_HEX = '0x89';
      const currentChain = ((await ethereum.request({
        method: 'eth_chainId',
      })) as string).toLowerCase();
      if (currentChain !== POLYGON_HEX) {
        setStatus('signing');
        try {
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: POLYGON_HEX }],
          });
        } catch (switchErr) {
          const code = (switchErr as { code?: number })?.code;
          // 4902 = chain not added yet. Prompt the user to add Polygon.
          if (code === 4902) {
            await ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: POLYGON_HEX,
                  chainName: 'Polygon',
                  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
                  rpcUrls: ['https://polygon-rpc.com'],
                  blockExplorerUrls: ['https://polygonscan.com'],
                },
              ],
            });
          } else {
            throw switchErr;
          }
        }
      }

      setStatus('preparing');
      const prep = await fetch('/api/trade/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recommendationId: rec.id,
          userAddress,
          signatureType: 0,
        }),
      });
      const prepBody = (await prep.json().catch(() => null)) as
        | { tradeId: string; typedData: { message: Record<string, unknown> } }
        | { error: string }
        | null;
      if (!prep.ok || !prepBody || 'error' in prepBody) {
        const reason =
          prepBody && 'error' in prepBody ? prepBody.error : `status ${prep.status}`;
        throw new Error(`prepare failed: ${reason}`);
      }
      const { tradeId, typedData } = prepBody;

      setStatus('signing');
      // EIP-712 typed-data sign. MetaMask wants the payload JSON-stringified
      // as the second param; signature comes back as a 0x-prefixed hex string.
      const signature = (await ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [userAddress, JSON.stringify(typedData)],
      })) as string;

      // typedData.message already contains every Order field the submit
      // route validates (salt, maker, signer, taker, tokenId, makerAmount,
      // takerAmount, expiration, nonce, feeRateBps, side, signatureType).
      // We just append the signature.
      const signedOrder = { ...typedData.message, signature };

      setStatus('submitting');
      const submit = await fetch('/api/trade/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tradeId, signedOrder }),
      });
      const submitBody = (await submit.json().catch(() => null)) as
        | { tradeId: string; clobOrderId: string | null; status: string }
        | { error: string; reason?: string }
        | null;
      if (!submit.ok || !submitBody || 'error' in submitBody) {
        const reason =
          submitBody && 'error' in submitBody
            ? `${submitBody.error}${submitBody.reason ? `: ${submitBody.reason}` : ''}`
            : `status ${submit.status}`;
        throw new Error(`submit failed: ${reason}`);
      }
      setClobOrderId(submitBody.clobOrderId);
      setStatus('done');
    } catch (e) {
      setStatus('error');
      // EIP-1193 errors from injected wallets are plain `{ code, message }`
      // objects, not Error instances. `String({…})` yields "[object Object]",
      // so we extract `.message` manually before falling back.
      let code: number | undefined;
      let msg: string;
      if (typeof e === 'object' && e !== null) {
        const obj = e as Record<string, unknown>;
        if (typeof obj.code === 'number') code = obj.code;
        msg =
          typeof obj.message === 'string'
            ? obj.message
            : e instanceof Error
              ? e.message
              : JSON.stringify(e);
      } else {
        msg = String(e);
      }
      if (code === 4001) setError('signature rejected');
      else if (code === 4100) setError('wallet not authorized for this account');
      else setError(msg);
    }
  }

  const buy = rec.side === 'BUY';

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition hover:border-white/[0.12] hover:bg-white/[0.04]">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="text-[13px] font-medium leading-snug text-zinc-100">
          {rec.market_question ?? '(unknown market)'}
        </h3>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide ${
            buy
              ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
              : 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30'
          }`}
        >
          {rec.side} @ {Number(rec.price).toFixed(2)}
        </span>
      </div>

      <p className="mb-2.5 line-clamp-3 text-[11px] leading-relaxed text-zinc-400">
        {rec.rationale}
      </p>

      <div className="mb-2.5 flex items-center gap-3 text-[10px] uppercase tracking-wider text-zinc-500">
        <span>size {Number(rec.size).toFixed(2)}</span>
        <span className="h-0.5 w-0.5 rounded-full bg-zinc-700" />
        <span className="text-emerald-300/80">
          {(rec.conviction * 100).toFixed(0)}% conviction
        </span>
      </div>

      <button
        onClick={() => void execute()}
        disabled={
          status === 'preparing' ||
          status === 'signing' ||
          status === 'submitting' ||
          status === 'done'
        }
        className="w-full rounded-lg bg-zinc-50 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
      >
        {status === 'idle' ? 'execute' : status === 'error' ? 'retry' : status}
      </button>
      {status === 'done' && clobOrderId ? (
        <p className="mt-2 truncate font-mono text-[10px] text-emerald-300/80">
          order {clobOrderId}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-[10px] text-rose-400">{error}</p>
      ) : null}
    </div>
  );
}
