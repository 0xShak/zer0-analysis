'use client';

import { useEffect, useState } from 'react';
import { ChatBox } from '@/components/ChatBox';
import { ThoughtsStream } from '@/components/ThoughtsStream';
import { TradeCard, type TradeRecommendation } from '@/components/TradeCard';
import { WalletConnect } from '@/components/WalletConnect';
import { createClient } from '@/lib/supabase/client';

export default function AppPage() {
  const [wallet, setWallet] = useState<string | undefined>();
  const [trades, setTrades] = useState<TradeRecommendation[]>([]);

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
      .channel('trades')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trade_recommendations' },
        ({ new: row }) => setTrades((prev) => [row as TradeRecommendation, ...prev].slice(0, 10)),
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, []);

  return (
    <main className="min-h-screen bg-black text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-900 px-6 py-3">
        <span className="text-lg font-bold tracking-tight">ZER0</span>
        <WalletConnect onConnect={setWallet} />
      </header>

      <div className="mx-auto grid h-[calc(100vh-57px)] max-w-7xl grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_1fr_1fr]">
        <section className="flex flex-col">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-widest text-zinc-500">
            Thoughts
          </h2>
          <div className="flex-1">
            <ThoughtsStream scope="app" />
          </div>
        </section>

        <section className="flex flex-col">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-widest text-zinc-500">
            Chat
          </h2>
          <div className="flex-1">
            <ChatBox walletAddress={wallet} />
          </div>
        </section>

        <section className="flex flex-col">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-widest text-zinc-500">
            Open recommendations
          </h2>
          <div className="flex-1 space-y-2 overflow-y-auto">
            {trades.length === 0 ? (
              <p className="text-sm text-zinc-600">No open recommendations yet.</p>
            ) : (
              trades.map((t) => <TradeCard key={t.id} rec={t} userAddress={wallet} />)
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
