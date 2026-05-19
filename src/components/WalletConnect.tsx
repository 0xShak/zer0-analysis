'use client';

import { useState } from 'react';

// Stub wallet connect — request accounts via window.ethereum.
// Day 5 in zer0.md §13 swaps this for Privy or RainbowKit + viem.
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
      setError('No injected wallet found');
      return;
    }
    try {
      const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[];
      if (accounts[0]) {
        setAddress(accounts[0]);
        onConnect(accounts[0]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      {address ? (
        <span className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-mono text-zinc-200">
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
      ) : (
        <button
          onClick={() => void connect()}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:border-emerald-500"
        >
          Connect wallet
        </button>
      )}
      {error ? <p className="mt-1 text-xs text-rose-400">{error}</p> : null}
    </div>
  );
}
