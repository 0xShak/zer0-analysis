'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { ThoughtsBubble } from './ThoughtsBubble';
import { TradesBubble } from './TradesBubble';
import { WalletConnect } from '@/components/WalletConnect';

export function ChatHeader({
  walletAddress,
  onWalletConnect,
}: {
  walletAddress?: string;
  onWalletConnect: (addr: string) => void;
}) {
  const [scanning, setScanning] = useState<number | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    async function load() {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { count } = await supabase
        .from('market_scans')
        .select('condition_id', { count: 'exact', head: true })
        .eq('deterministic', true)
        .gte('last_seen_at', since);
      if (!cancelled) setScanning(count ?? 0);
    }

    void load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <header className="flex items-center justify-between border-b border-white/[0.06] bg-black/30 px-4 py-3 backdrop-blur-sm sm:px-6">
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 overflow-hidden rounded-full border border-white/10 bg-white/[0.04]">
          <Image
            src="/zer0-img.png"
            alt="zer0"
            width={36}
            height={36}
            className="h-full w-full object-cover"
          />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold text-zinc-100">zer0</span>
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            online ·{' '}
            {scanning === null
              ? 'warming up'
              : scanning === 0
                ? 'no fresh markets'
                : `watching ${scanning} markets`}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <ThoughtsBubble />
        <TradesBubble userAddress={walletAddress} />
        <WalletConnect onConnect={onWalletConnect} />
      </div>
    </header>
  );
}
