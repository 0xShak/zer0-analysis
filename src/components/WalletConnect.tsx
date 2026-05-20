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

export function WalletConnect({
  onConnect,
}: {
  onConnect: (address: string) => void;
}) {
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setError(null);
    if (typeof window === 'undefined' || !window.ethereum) {
      setError('no injected wallet found');
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: 'eth_requestAccounts',
      })) as string[];
      if (accounts[0]) {
        setAddress(accounts[0]);
        onConnect(accounts[0]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (address) {
    return (
      <span
        className="flex h-9 items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 font-mono text-[11px] text-emerald-200"
        title={address}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        {address.slice(0, 6)}…{address.slice(-4)}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end">
      <button
        onClick={() => void connect()}
        className="flex h-9 items-center rounded-full border border-white/10 bg-white/[0.04] px-3.5 text-xs font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.07]"
      >
        connect wallet
      </button>
      {error ? (
        <span className="mt-1 text-[10px] text-rose-400">{error}</span>
      ) : null}
    </div>
  );
}
