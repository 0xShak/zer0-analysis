'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { TradeCard, type TradeRecommendation } from '@/components/TradeCard';

export function TradesBubble({ userAddress }: { userAddress?: string }) {
  const [open, setOpen] = useState(false);
  const [trades, setTrades] = useState<TradeRecommendation[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    void (async () => {
      const { data } = await supabase
        .from('trade_recommendations')
        .select('id, market_question, side, price, size, conviction, rationale')
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(10);
      if (!cancelled && data) setTrades(data as TradeRecommendation[]);
    })();

    const channel = supabase
      .channel('trades:open')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trade_recommendations' },
        ({ new: row }) => {
          setTrades((prev) =>
            [row as TradeRecommendation, ...prev].slice(0, 10),
          );
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const count = trades.length;
  const badge = count === 0 ? null : count > 9 ? '9+' : String(count);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="open trade recommendations"
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.07] hover:text-zinc-100"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M14 7h7v7" />
        </svg>
        {badge ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-black">
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          className="glass-strong absolute right-0 top-11 z-30 w-[22rem] overflow-hidden rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)] sm:w-[26rem]"
        >
          <div className="flex items-baseline justify-between border-b border-white/[0.06] px-4 py-2.5">
            <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-400">
              open trades
            </h3>
            <span className="text-[10px] text-zinc-500">{count} open</span>
          </div>
          <div className="max-h-[28rem] space-y-2 overflow-y-auto p-3">
            {trades.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-zinc-500">
                no open recommendations right now.
              </p>
            ) : (
              trades.map((t) => (
                <TradeCard key={t.id} rec={t} userAddress={userAddress} />
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
