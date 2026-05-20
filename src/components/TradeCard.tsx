'use client';

import { useState } from 'react';

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
    'idle' | 'preparing' | 'submitting' | 'done' | 'error'
  >('idle');
  const [error, setError] = useState<string | null>(null);

  async function execute() {
    if (!userAddress) {
      setError('connect a wallet first');
      return;
    }
    setStatus('preparing');
    setError(null);
    try {
      const prep = await fetch('/api/trade/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recommendationId: rec.id,
          userAddress,
          signatureType: 0,
        }),
      });
      if (!prep.ok) throw new Error(`prepare ${prep.status}`);
      throw new Error('wallet signing wired up on day 5');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
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
        disabled={status === 'preparing' || status === 'submitting'}
        className="w-full rounded-lg bg-zinc-50 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
      >
        {status === 'idle' ? 'execute' : status}
      </button>
      {error ? (
        <p className="mt-2 text-[10px] text-rose-400">{error}</p>
      ) : null}
    </div>
  );
}
