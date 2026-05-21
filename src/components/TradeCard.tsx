'use client';

import { useEffect, useState } from 'react';
import {
  sendApproveUsdc,
  sendSetApprovalForAllCtf,
  waitForReceipt,
} from '@/lib/web3/approve';

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

type ApprovalState = {
  usdcOk: boolean;
  ctfOk: boolean;
  spender: string;
  negRisk: boolean;
  unknown?: boolean;
};

// Treat any non-zero USDC allowance as "approved" — the in-app flow only
// ever sets MAX_UINT256, so any positive value means we (or Polymarket's
// UI in the past) granted access. A single full-token threshold gives some
// slack against rounding without being so high it ignores partial revokes.
const USDC_OK_THRESHOLD = BigInt(1000000); // 1 USDC.e (6 decimals) in micro-units

export function TradeCard({
  rec,
  userAddress,
}: {
  rec: TradeRecommendation;
  userAddress?: string;
}) {
  const [status, setStatus] = useState<
    | 'idle'
    | 'checking-allowance'
    | 'approving-usdc'
    | 'approving-ctf'
    | 'preparing'
    | 'signing'
    | 'submitting'
    | 'done'
    | 'cancelled'
    | 'error'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const [clobOrderId, setClobOrderId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  // Size is in USD (server caps at $1-$100 via PrepareBody). The wallet
  // popup will show this converted to share-denominated maker/taker amounts.
  const [sizeUsdInput, setSizeUsdInput] = useState<string>(
    Number(rec.size).toFixed(2),
  );

  const sizeUsd = Number.parseFloat(sizeUsdInput);
  const sizeValid =
    Number.isFinite(sizeUsd) && sizeUsd >= 1 && sizeUsd <= 100;
  const sharesEstimate =
    sizeValid && rec.price > 0 ? sizeUsd / Number(rec.price) : null;
  const inFlight =
    status === 'checking-allowance' ||
    status === 'approving-usdc' ||
    status === 'approving-ctf' ||
    status === 'preparing' ||
    status === 'signing' ||
    status === 'submitting';
  const needsUsdcApproval = !!approval && !approval.usdcOk;
  const needsCtfApproval =
    !!approval && rec.side === 'SELL' && !approval.ctfOk;
  const setupRequired = needsUsdcApproval || needsCtfApproval;

  // Allowance preflight — fires when wallet connects or the recommendation
  // changes. The server reads USDC.e.allowance + CTF.isApprovedForAll from
  // a public Polygon RPC; no signing is required. If anything is missing,
  // we surface a small "first-time setup" notice; clicking execute will
  // run the approve tx(s) inline before signing the order.
  useEffect(() => {
    if (!userAddress) return;
    let cancelled = false;
    async function loadAllowance() {
      try {
        const res = await fetch(
          `/api/trade/allowance?address=${encodeURIComponent(userAddress!)}&recommendationId=${rec.id}`,
          { cache: 'no-store' },
        );
        if (cancelled) return;
        if (!res.ok) return;
        const body = (await res.json()) as {
          unknown?: boolean;
          usdc: { allowance?: string; spender: string };
          ctf: { approved?: boolean; spender: string };
          exchange: { negRisk: boolean };
        };
        if (cancelled) return;
        if (body.unknown) {
          // All RPCs failed. Default to "approval unknown" — UI will show a
          // soft notice and the user can still try execute; the worst case
          // is one extra wallet popup when the order is actually rejected.
          setApproval({
            usdcOk: false,
            ctfOk: false,
            spender: body.usdc.spender,
            negRisk: body.exchange.negRisk,
            unknown: true,
          });
          return;
        }
        let allowanceBig: bigint;
        try {
          allowanceBig = BigInt(body.usdc.allowance ?? '0');
        } catch {
          allowanceBig = BigInt(0);
        }
        setApproval({
          usdcOk: allowanceBig >= USDC_OK_THRESHOLD,
          ctfOk: !!body.ctf.approved,
          spender: body.usdc.spender,
          negRisk: body.exchange.negRisk,
        });
      } catch {
        // Allowance is best-effort. If preflight fails the user can still
        // try execute; submit will surface the real CLOB rejection.
      }
    }
    void loadAllowance();
    return () => {
      cancelled = true;
    };
  }, [userAddress, rec.id]);

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
    if (!sizeValid) {
      setError('size must be $1-$100');
      return;
    }
    setError(null);
    setClobOrderId(null);
    setCancelReason(null);
    try {
      // Defensive preflight — if the user clicked execute before the
      // background allowance fetch settled, do it now synchronously.
      // Without this, `approval` could be null at this point, causing
      // `needsUsdcApproval` to evaluate false and silently skipping the
      // approve step. That's exactly the race that produced Polymarket
      // submissions on wallets with zero allowance.
      let currentApproval = approval;
      if (!currentApproval) {
        setStatus('checking-allowance');
        try {
          const res = await fetch(
            `/api/trade/allowance?address=${encodeURIComponent(userAddress)}&recommendationId=${rec.id}`,
            { cache: 'no-store' },
          );
          if (res.ok) {
            const body = (await res.json()) as {
              unknown?: boolean;
              usdc: { allowance?: string; spender: string };
              ctf: { approved?: boolean; spender: string };
              exchange: { negRisk: boolean };
            };
            if (body.unknown) {
              currentApproval = {
                usdcOk: false,
                ctfOk: false,
                spender: body.usdc.spender,
                negRisk: body.exchange.negRisk,
                unknown: true,
              };
            } else {
              let allowanceBig: bigint;
              try {
                allowanceBig = BigInt(body.usdc.allowance ?? '0');
              } catch {
                allowanceBig = BigInt(0);
              }
              currentApproval = {
                usdcOk: allowanceBig >= USDC_OK_THRESHOLD,
                ctfOk: !!body.ctf.approved,
                spender: body.usdc.spender,
                negRisk: body.exchange.negRisk,
              };
            }
            setApproval(currentApproval);
          }
        } catch {
          // Allowance fetch is best-effort; if it blows up we proceed
          // without preflight data. Polymarket will surface the real
          // rejection at submit time if allowance is missing.
        }
      }
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

      // First-time setup: approve USDC.e (always for any side) and CTF
      // setApprovalForAll (SELL only). Each is one on-chain tx the user
      // signs in their wallet. We wait for receipts so a subsequent
      // signTypedData / postOrder doesn't race ahead of the approval.
      // We use `currentApproval` (just-fetched if needed) rather than the
      // possibly-stale closure `approval` to avoid the race condition.
      if (currentApproval) {
        const usdcNeeded = !currentApproval.usdcOk;
        const ctfNeeded =
          rec.side === 'SELL' && !currentApproval.ctfOk;
        if (usdcNeeded) {
          setStatus('approving-usdc');
          const txHash = await sendApproveUsdc(
            ethereum,
            userAddress,
            currentApproval.spender,
          );
          const receipt = await waitForReceipt(ethereum, txHash);
          if (receipt.status !== 'success') {
            throw new Error('USDC approve tx reverted');
          }
        }
        if (ctfNeeded) {
          setStatus('approving-ctf');
          const txHash = await sendSetApprovalForAllCtf(
            ethereum,
            userAddress,
            currentApproval.spender,
          );
          const receipt = await waitForReceipt(ethereum, txHash);
          if (receipt.status !== 'success') {
            throw new Error('CTF approve tx reverted');
          }
        }
        if (usdcNeeded || ctfNeeded) {
          // Locally mark approvals as done so a retry within this session
          // skips the on-chain dance. A reload will re-check.
          setApproval({
            ...currentApproval,
            usdcOk: true,
            ctfOk: rec.side === 'SELL' ? true : currentApproval.ctfOk,
            unknown: false,
          });
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
          sizeOverrideUsd: sizeUsd,
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
        | {
            tradeId: string;
            clobOrderId: string | null;
            status: string;
            reason?: string | null;
          }
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
      // Polymarket-side classification: 'filled' means on-chain settlement
      // happened; 'cancelled' means the FAK didn't match (book moved,
      // missing allowance, etc.). Either way the order is final.
      if (submitBody.status === 'cancelled') {
        setCancelReason(submitBody.reason ?? 'order did not match the book');
        setStatus('cancelled');
      } else {
        setStatus('done');
      }
      // Tell RecentTradesBubble (or any other listener) to refresh — the
      // trades-list endpoint reads from the trades table the submit route
      // just wrote to, so the new row should appear on the next fetch.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('zer0:trade-submitted'));
      }
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

      <div className="mb-2.5 flex items-center justify-between gap-3 text-[10px] uppercase tracking-wider text-zinc-500">
        <label className="flex items-center gap-1.5 normal-case tracking-normal">
          <span className="text-[10px] uppercase tracking-wider">size $</span>
          <input
            type="number"
            min={1}
            max={100}
            step={0.01}
            value={sizeUsdInput}
            onChange={(e) => setSizeUsdInput(e.target.value)}
            disabled={inFlight || status === 'done'}
            className={`w-16 rounded border bg-white/[0.03] px-1.5 py-0.5 text-right font-mono text-[11px] text-zinc-200 focus:outline-none disabled:opacity-50 ${
              sizeValid
                ? 'border-white/[0.08] focus:border-white/20'
                : 'border-rose-500/40 focus:border-rose-500/60'
            }`}
          />
          {sharesEstimate !== null ? (
            <span className="font-mono text-[10px] normal-case tracking-normal text-zinc-500">
              ≈ {sharesEstimate.toFixed(sharesEstimate >= 100 ? 0 : 2)} shares
            </span>
          ) : null}
        </label>
        <span className="text-emerald-300/80">
          {(rec.conviction * 100).toFixed(0)}% conviction
        </span>
      </div>

      {approval?.unknown && status === 'idle' ? (
        <p className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-200">
          couldn&apos;t verify wallet approvals (RPC timed out). proceeding may
          require an extra wallet popup if the trade needs an approve tx.
        </p>
      ) : setupRequired && status === 'idle' ? (
        <p className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-200">
          first-time setup: clicking execute will prompt{' '}
          {needsUsdcApproval && needsCtfApproval
            ? 'USDC.e and share approvals'
            : needsUsdcApproval
              ? 'a one-time USDC.e approval'
              : 'a one-time share-token approval'}{' '}
          before signing the order.
        </p>
      ) : null}

      <button
        onClick={() => void execute()}
        disabled={inFlight || status === 'done' || !sizeValid}
        className="w-full rounded-lg bg-zinc-50 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
      >
        {status === 'idle'
          ? setupRequired
            ? 'approve & execute'
            : 'execute'
          : status === 'error' || status === 'cancelled'
            ? 'try again'
            : status}
      </button>
      {status === 'done' && clobOrderId ? (
        <p className="mt-2 truncate font-mono text-[10px] text-emerald-300/80">
          filled · order {clobOrderId}
        </p>
      ) : null}
      {status === 'cancelled' ? (
        <p className="mt-2 text-[10px] leading-snug text-amber-300">
          didn&apos;t fill: {cancelReason ?? 'order was unmatched'}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-[10px] text-rose-400">{error}</p>
      ) : null}
    </div>
  );
}
