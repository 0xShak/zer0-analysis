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

export function TradeCard({ rec, userAddress }: { rec: TradeRecommendation; userAddress?: string }) {
  const [status, setStatus] = useState<'idle' | 'preparing' | 'submitting' | 'done' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  async function execute() {
    if (!userAddress) {
      setError('Connect a wallet first');
      return;
    }
    setStatus('preparing');
    setError(null);
    try {
      const prep = await fetch('/api/trade/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recommendationId: rec.id, userAddress, signatureType: 0 }),
      });
      if (!prep.ok) throw new Error(`prepare ${prep.status}`);
      // TODO: signer.signTypedData(domain, types, value) via viem/wagmi (zer0.md §8).
      throw new Error('wallet signing wired up on Day 5');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-100">{rec.market_question}</h3>
        <span
          className={`rounded px-2 py-0.5 text-xs font-bold ${
            rec.side === 'BUY' ? 'bg-emerald-700 text-emerald-50' : 'bg-rose-700 text-rose-50'
          }`}
        >
          {rec.side} @ {rec.price}
        </span>
      </div>
      <p className="mb-3 text-xs text-zinc-400">{rec.rationale}</p>
      <div className="mb-3 flex items-center gap-3 text-xs text-zinc-500">
        <span>size {rec.size}</span>
        <span>conviction {(rec.conviction * 100).toFixed(0)}%</span>
      </div>
      <button
        onClick={() => void execute()}
        disabled={status === 'preparing' || status === 'submitting'}
        className="w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {status === 'idle' ? 'Execute' : status}
      </button>
      {error ? <p className="mt-2 text-xs text-rose-400">{error}</p> : null}
    </div>
  );
}
