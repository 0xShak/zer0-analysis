'use client';

import { useEffect, useState } from 'react';
import {
  sendApproveUsdcForOnramp,
  sendWrapUsdc,
  waitForReceipt,
} from '@/lib/web3/approve';
import {
  getOrCreatePolymarketClient,
  hasCachedCreds,
  pollOrderFromBrowser,
  submitOrderFromBrowser,
  syncDepositWalletBalance,
} from '@/lib/polymarket/clob-browser';
import {
  deployDepositWalletFromBrowser,
  encodeCtfApproveAllCall,
  encodePusdApproveCall,
  executeDepositWalletBatchFromBrowser,
} from '@/lib/polymarket/deposit-wallet';
import type { SignedOrder } from '@polymarket/clob-client-v2';

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

type AllowanceData = {
  depositWallet: { address: string; deployed: boolean };
  pusd: { balance: bigint; allowance: bigint; spender: string };
  usdce: { balance: bigint; allowance: bigint; onramp: string };
  ctf: { approved: boolean; spender: string };
  negRisk: boolean;
  unknown?: boolean;
};

const PUSD_OK_THRESHOLD = BigInt(1_000_000); // $1 in 6-decimal micro-units
const USDCE_OK_THRESHOLD = BigInt(1_000_000);

function usdToMicros(usd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return BigInt(0);
  return BigInt(Math.ceil(usd * 1_000_000));
}

function parseBigInt(s: string | undefined | null): bigint {
  try {
    return BigInt(s ?? '0');
  } catch {
    return BigInt(0);
  }
}

function parseAllowanceResponse(body: unknown): AllowanceData | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const depositWalletRaw = b.depositWallet as Record<string, unknown> | undefined;
  const pusdRaw = b.pusd as Record<string, unknown> | undefined;
  const usdceRaw = b.usdce as Record<string, unknown> | undefined;
  const ctfRaw = b.ctf as Record<string, unknown> | undefined;
  const exchangeRaw = b.exchange as Record<string, unknown> | undefined;
  if (!depositWalletRaw || !pusdRaw || !usdceRaw || !ctfRaw) return null;
  return {
    depositWallet: {
      address: String(depositWalletRaw.address ?? ''),
      deployed: Boolean(depositWalletRaw.deployed),
    },
    pusd: {
      balance: parseBigInt(pusdRaw.balance as string | undefined),
      allowance: parseBigInt(pusdRaw.allowance as string | undefined),
      spender: String(pusdRaw.spender ?? ''),
    },
    usdce: {
      balance: parseBigInt(usdceRaw.balance as string | undefined),
      allowance: parseBigInt(usdceRaw.allowance as string | undefined),
      onramp: String(usdceRaw.onramp ?? ''),
    },
    ctf: {
      approved: Boolean(ctfRaw.approved),
      spender: String(ctfRaw.spender ?? ''),
    },
    negRisk: Boolean(exchangeRaw?.negRisk),
    unknown: Boolean(b.unknown),
  };
}

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
    | 'deploying-wallet'
    | 'approving-usdce-onramp'
    | 'wrapping'
    | 'approving-wallet'
    | 'syncing-balance'
    | 'preparing'
    | 'signing'
    | 'deriving-keys'
    | 'submitting'
    | 'done'
    | 'cancelled'
    | 'error'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const [clobOrderId, setClobOrderId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  const [allowance, setAllowance] = useState<AllowanceData | null>(null);
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
    status === 'deploying-wallet' ||
    status === 'approving-usdce-onramp' ||
    status === 'wrapping' ||
    status === 'approving-wallet' ||
    status === 'syncing-balance' ||
    status === 'preparing' ||
    status === 'signing' ||
    status === 'deriving-keys' ||
    status === 'submitting';

  // V2 deposit-wallet setup state. BUYs need pUSD held BY THE WALLET
  // (sourced via the USDC.e → Onramp.wrap path with `to = depositWallet`).
  // SELLs need CTF.setApprovalForAll set BY THE WALLET. Both sides leave a
  // pUSD allowance from the wallet on the V2 Exchange so future trades
  // skip the relayer-batch popup.
  const sizeUsdMicros = usdToMicros(sizeValid ? sizeUsd : 0);
  const needsDeploy = !!allowance && !allowance.depositWallet.deployed;
  const needsWrap =
    rec.side === 'BUY' && !!allowance && allowance.pusd.balance < sizeUsdMicros;
  const wrapAmountMicros =
    needsWrap && allowance
      ? sizeUsdMicros - allowance.pusd.balance
      : BigInt(0);
  const needsUsdceForOnramp =
    !!allowance && needsWrap && allowance.usdce.allowance < USDCE_OK_THRESHOLD;
  const insufficientUsdce =
    !!allowance && needsWrap && allowance.usdce.balance < wrapAmountMicros;
  const needsPusdApproval =
    !!allowance && allowance.pusd.allowance < PUSD_OK_THRESHOLD;
  const needsCtfApproval =
    !!allowance && rec.side === 'SELL' && !allowance.ctf.approved;
  const setupRequired =
    needsDeploy ||
    needsUsdceForOnramp ||
    needsWrap ||
    needsPusdApproval ||
    needsCtfApproval;

  // Preflight — fires when wallet connects or the recommendation changes.
  // Server reads pUSD/USDC.e balances + allowances + CTF approval + wallet
  // deployment status via a public Polygon RPC; no signing required. If
  // anything is missing the UI surfaces a "first-time setup" notice; on
  // execute the missing steps run inline.
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
        const parsed = parseAllowanceResponse(await res.json());
        if (parsed && !cancelled) setAllowance(parsed);
      } catch {
        // best-effort
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
      let current = allowance;
      if (!current) {
        setStatus('checking-allowance');
        try {
          const res = await fetch(
            `/api/trade/allowance?address=${encodeURIComponent(userAddress)}&recommendationId=${rec.id}`,
            { cache: 'no-store' },
          );
          if (res.ok) {
            const parsed = parseAllowanceResponse(await res.json());
            if (parsed) {
              current = parsed;
              setAllowance(parsed);
            }
          }
        } catch {
          // best-effort
        }
      }

      // Polymarket is on Polygon (chainId 137 / 0x89). The EIP-712 domain we
      // sign also encodes 137 — wallets on a different chain reject the
      // sign request with -32603.
      const POLYGON_HEX = '0x89';
      const currentChain = ((await ethereum.request({
        method: 'eth_chainId',
      })) as string).toLowerCase();
      if (currentChain !== POLYGON_HEX) {
        try {
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: POLYGON_HEX }],
          });
        } catch (switchErr) {
          const code = (switchErr as { code?: number })?.code;
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

      if (!current) {
        throw new Error(
          'could not read account state — try reconnecting your wallet',
        );
      }

      const depositWalletAddr = current.depositWallet.address;

      // ----- 1. Deploy deposit wallet via relayer if needed (no popup) -----
      let walletDeployed = current.depositWallet.deployed;
      if (!walletDeployed) {
        setStatus('deploying-wallet');
        await deployDepositWalletFromBrowser(ethereum, userAddress);
        walletDeployed = true;
      }

      // ----- 2. EOA-signed: top up pUSD in the deposit wallet (BUY only) -----
      let pusdBalanceAfterWrap = current.pusd.balance;
      if (rec.side === 'BUY' && pusdBalanceAfterWrap < sizeUsdMicros) {
        const wrapDelta = sizeUsdMicros - pusdBalanceAfterWrap;
        if (current.usdce.balance < wrapDelta) {
          throw new Error(
            `insufficient USDC.e: need $${(Number(wrapDelta) / 1_000_000).toFixed(2)}, have $${(Number(current.usdce.balance) / 1_000_000).toFixed(2)}`,
          );
        }
        if (current.usdce.allowance < wrapDelta) {
          setStatus('approving-usdce-onramp');
          const txHash = await sendApproveUsdcForOnramp(
            ethereum,
            userAddress,
            current.usdce.onramp,
          );
          const receipt = await waitForReceipt(ethereum, txHash);
          if (receipt.status !== 'success') {
            throw new Error('USDC.e approve (Onramp) tx reverted');
          }
        }
        setStatus('wrapping');
        const txHash = await sendWrapUsdc(
          ethereum,
          userAddress,
          current.usdce.onramp,
          depositWalletAddr,
          wrapDelta,
        );
        const receipt = await waitForReceipt(ethereum, txHash);
        if (receipt.status !== 'success') {
          throw new Error('USDC.e → pUSD wrap tx reverted');
        }
        pusdBalanceAfterWrap = pusdBalanceAfterWrap + wrapDelta;
      }

      // ----- 3. Relayer-batched approvals from inside the wallet (1 sig) -----
      // pUSD.approve + (SELL only) CTF.setApprovalForAll in a single batch
      // signature so the user sees one popup, not two.
      const batchCalls = [];
      if (current.pusd.allowance < PUSD_OK_THRESHOLD) {
        batchCalls.push(encodePusdApproveCall(current.pusd.spender));
      }
      if (rec.side === 'SELL' && !current.ctf.approved) {
        batchCalls.push(encodeCtfApproveAllCall(current.ctf.spender));
      }
      if (batchCalls.length > 0) {
        setStatus('approving-wallet');
        await executeDepositWalletBatchFromBrowser(
          ethereum,
          userAddress,
          depositWalletAddr,
          batchCalls,
        );
      }

      // Reflect locally so a retry-in-same-session doesn't re-run setup.
      setAllowance({
        ...current,
        depositWallet: { ...current.depositWallet, deployed: walletDeployed },
        pusd: {
          ...current.pusd,
          balance: pusdBalanceAfterWrap,
          allowance:
            current.pusd.allowance < PUSD_OK_THRESHOLD
              ? BigInt(2) ** BigInt(255)
              : current.pusd.allowance,
        },
        usdce: {
          ...current.usdce,
          balance:
            rec.side === 'BUY' && pusdBalanceAfterWrap !== current.pusd.balance
              ? current.usdce.balance - (pusdBalanceAfterWrap - current.pusd.balance)
              : current.usdce.balance,
          allowance:
            rec.side === 'BUY' && current.usdce.allowance < sizeUsdMicros
              ? BigInt(2) ** BigInt(255)
              : current.usdce.allowance,
        },
        ctf: {
          ...current.ctf,
          approved: rec.side === 'SELL' ? true : current.ctf.approved,
        },
        unknown: false,
      });

      // ----- 4. Initialize CLOB browser client (one-time api-key popup) -----
      if (!hasCachedCreds(userAddress)) {
        setStatus('deriving-keys');
      }
      const pmClient = await getOrCreatePolymarketClient(
        ethereum,
        userAddress,
        depositWalletAddr,
      );

      // ----- 5. Sync the matcher's balance cache for the deposit wallet -----
      setStatus('syncing-balance');
      await syncDepositWalletBalance(pmClient);

      // ----- 6. Prepare typed-data on the server (POLY_1271) -----
      setStatus('preparing');
      const prep = await fetch('/api/trade/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recommendationId: rec.id,
          userAddress,
          signatureType: 3,
          sizeOverrideUsd: sizeUsd,
        }),
      });
      const prepBody = (await prep.json().catch(() => null)) as
        | {
            tradeId: string;
            typedData: Record<string, unknown>;
            order: Record<string, unknown>;
            wrapSuffix: string;
          }
        | { error: string }
        | null;
      if (!prep.ok || !prepBody || 'error' in prepBody) {
        const reason =
          prepBody && 'error' in prepBody ? prepBody.error : `status ${prep.status}`;
        throw new Error(`prepare failed: ${reason}`);
      }
      const { tradeId, typedData, order, wrapSuffix } = prepBody;

      setStatus('signing');
      // For POLY_1271 the wallet sees a TypedDataSign payload (Order is
      // nested inside). MetaMask still renders this as a typed-data sign —
      // the user just sees a more elaborate structure.
      const innerSig = (await ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [userAddress, JSON.stringify(typedData)],
      })) as string;
      if (!wrapSuffix) {
        throw new Error('server returned no wrapSuffix for POLY_1271 order');
      }
      // ERC-7739: append app domain sep + contents hash + type string + len.
      const fullSignature = `0x${innerSig.slice(2)}${wrapSuffix.slice(2)}`;
      const signedOrder = { ...order, signature: fullSignature };

      setStatus('submitting');
      const clobResult = await submitOrderFromBrowser(
        pmClient,
        signedOrder as unknown as SignedOrder,
      );

      const resultObj =
        typeof clobResult === 'object' && clobResult !== null
          ? (clobResult as Record<string, unknown>)
          : {};
      const httpErrorMsg =
        typeof resultObj.error === 'string' && resultObj.error
          ? resultObj.error
          : null;
      const isSoftReject = resultObj.success === false;
      if (httpErrorMsg || isSoftReject) {
        const reason =
          (typeof resultObj.errorMsg === 'string' && resultObj.errorMsg) ||
          httpErrorMsg ||
          'CLOB rejected order';
        await fetch('/api/trade/notify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tradeId,
            outcome: { kind: 'rejected', reason },
          }),
        });
        throw new Error(`submit failed: clob_rejected: ${reason}`);
      }

      const apiClobOrderId =
        (typeof resultObj.orderID === 'string' && resultObj.orderID) ||
        (typeof resultObj.orderId === 'string' && resultObj.orderId) ||
        null;
      const inlineStatus =
        typeof resultObj.status === 'string' ? resultObj.status : '';
      const inlineTxHashes = Array.isArray(resultObj.transactionsHashes)
        ? (resultObj.transactionsHashes as unknown[]).filter(
            (h): h is string => typeof h === 'string',
          )
        : [];
      const inlineMatched =
        inlineStatus === 'matched' ||
        inlineStatus === 'filled' ||
        inlineTxHashes.length > 0;

      let matched = inlineMatched;
      let polledStatus = inlineStatus;
      let polledSizeMatched = '';
      if (!inlineMatched && apiClobOrderId) {
        const resolution = await pollOrderFromBrowser(pmClient, apiClobOrderId);
        if (resolution.kind === 'matched') {
          matched = true;
          polledStatus = resolution.status || 'MATCHED';
          polledSizeMatched = resolution.sizeMatched;
        } else if (resolution.kind === 'cancelled') {
          polledStatus = resolution.status || 'CANCELED';
          polledSizeMatched = resolution.sizeMatched;
        } else {
          polledStatus = resolution.status || 'TIMEOUT';
          polledSizeMatched = resolution.sizeMatched;
        }
      }

      setClobOrderId(apiClobOrderId);
      if (matched) {
        await fetch('/api/trade/notify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tradeId,
            outcome: {
              kind: 'filled',
              clobOrderId: apiClobOrderId,
              txHashes: inlineTxHashes,
              sizeMatched: polledSizeMatched,
              clobStatus: polledStatus,
            },
          }),
        });
        setStatus('done');
      } else {
        const reason = `unmatched: status="${polledStatus || 'unknown'}", size_matched=${
          polledSizeMatched || '0'
        }`;
        await fetch('/api/trade/notify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tradeId,
            outcome: {
              kind: 'cancelled',
              clobOrderId: apiClobOrderId,
              reason,
            },
          }),
        });
        setCancelReason(reason);
        setStatus('cancelled');
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('zer0:trade-submitted'));
      }
    } catch (e) {
      setStatus('error');
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

  // Build the first-time-setup label. The user might need any subset of:
  // deploy wallet (silent), wrap (USDC.e → pUSD), wallet-batched pUSD
  // approve, wallet-batched CTF approve (SELL only).
  let setupLabel: string | null = null;
  if (setupRequired && status === 'idle') {
    if (insufficientUsdce) {
      setupLabel = `need $${(Number(sizeUsdMicros) / 1_000_000).toFixed(2)} of USDC.e or pUSD — your balance is lower`;
    } else {
      const steps: string[] = [];
      if (needsDeploy) steps.push('deploy Polymarket wallet (free)');
      if (needsWrap) steps.push('wrap USDC.e → pUSD');
      if (needsPusdApproval || needsCtfApproval) steps.push('approve trading');
      if (steps.length > 0) {
        setupLabel = `first-time setup: ${steps.join(' + ')} before signing`;
      }
    }
  }

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

      {allowance?.unknown && status === 'idle' ? (
        <p className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-200">
          couldn&apos;t verify wallet state (RPC timed out). proceeding may
          require extra wallet popups if setup is incomplete.
        </p>
      ) : setupLabel ? (
        <p className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-200">
          {setupLabel}
        </p>
      ) : null}

      <button
        onClick={() => void execute()}
        disabled={inFlight || status === 'done' || !sizeValid || insufficientUsdce}
        className="w-full rounded-lg bg-zinc-50 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
      >
        {status === 'idle'
          ? setupRequired
            ? 'set up & execute'
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
