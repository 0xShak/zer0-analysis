'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { payForSim, signSimPayment } from '@/lib/web3/sim-pay-browser';

// Minimal web trigger for run-a-sim. Posts the scenario to /api/sim; when the
// payment gate is on it returns a $ZER0 quote and we collect the fee in-browser
// (injected wallet → ERC-20 transfer on Base → /api/sim/verify) before sending
// the user to /sim/<id> to watch it run. Result UI reuses MiroShark's own watch
// + share-card pages (§1).

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

interface Quote {
  priceZer0: string;
  amountBaseUnits: string;
  tokenAddress: string;
  sinkAddress: string;
}

type PayStatus = 'idle' | 'paying' | 'verifying' | 'error';

function errMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const obj = e as { code?: number; message?: string };
    if (obj.code === 4001) return 'Payment rejected in wallet.';
    if (typeof obj.message === 'string') return obj.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export default function SimTriggerPage() {
  const router = useRouter();
  const [scenario, setScenario] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pendingSimId, setPendingSimId] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [payStatus, setPayStatus] = useState<PayStatus>('idle');
  const [payError, setPayError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (scenario.trim().length < 8) {
      setError('Give me a full sentence to simulate.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/sim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: scenario.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message ?? 'Could not start the sim.');
        return;
      }
      if (data.needs_payment) {
        setQuote(data.quote);
        setPendingSimId(data.pending_sim_id);
        return;
      }
      router.push(`/sim/${data.pending_sim_id}`);
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setPayError(null);
    const ethereum = typeof window !== 'undefined' ? window.ethereum : undefined;
    if (!ethereum) {
      setPayError('No wallet found. Install MetaMask/Coinbase Wallet, or run /sim in Telegram.');
      return;
    }
    try {
      const accounts = (await ethereum.request({
        method: 'eth_requestAccounts',
      })) as string[];
      if (accounts[0]) setAddress(accounts[0]);
    } catch (e) {
      setPayError(errMessage(e));
    }
  }

  async function pay() {
    if (!quote || !pendingSimId || !address) return;
    const ethereum = typeof window !== 'undefined' ? window.ethereum : undefined;
    if (!ethereum) {
      setPayError('No wallet found.');
      return;
    }
    setPayError(null);
    setPayStatus('paying');
    try {
      // Prove control of the paying wallet first (gasless). The server binds
      // on-chain verification to this signer, so nobody can claim our payment.
      const signature = await signSimPayment({
        ethereum,
        from: address,
        pendingSimId,
      });

      const txHash = await payForSim({
        ethereum,
        from: address,
        tokenAddress: quote.tokenAddress,
        sinkAddress: quote.sinkAddress,
        amountBaseUnits: quote.amountBaseUnits,
      });

      setPayStatus('verifying');
      const res = await fetch('/api/sim/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pending_sim_id: pendingSimId,
          tx_hash: txHash,
          from_address: address,
          signature,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setPayStatus('error');
        setPayError(
          `Payment didn't verify (${data?.reason ?? `status ${res.status}`}). If it went through, keep this tx: ${txHash}`,
        );
        return;
      }
      router.push(`/sim/${pendingSimId}`);
    } catch (e) {
      setPayStatus('error');
      setPayError(errMessage(e));
    }
  }

  const paying = payStatus === 'paying' || payStatus === 'verifying';

  return (
    <main style={styles.wrap}>
      <h1 style={styles.h1}>Run a swarm sim</h1>
      <p style={styles.lead}>
        Describe a scenario. ZER0 spins up a MiroShark swarm of agents, runs it,
        and hands back a signal + share card.
      </p>
      <textarea
        value={scenario}
        onChange={(e) => setScenario(e.target.value)}
        placeholder="e.g. What happens to BTC if the Fed cuts rates in March?"
        rows={4}
        style={styles.textarea}
        disabled={busy || quote !== null}
      />
      {!quote && (
        <button onClick={submit} disabled={busy} style={styles.button}>
          {busy ? 'Starting…' : 'Run sim'}
        </button>
      )}
      {error && <p style={styles.error}>{error}</p>}

      {quote && (
        <div style={styles.payBox}>
          <p style={styles.payLine}>
            One swarm sim costs <strong>{quote.priceZer0} $ZER0</strong> on Base.
            The fee is burned 🔥 (sent to the dead address).
          </p>
          {!address ? (
            <button onClick={connect} style={styles.button}>
              Connect wallet
            </button>
          ) : (
            <>
              <p style={styles.addr}>
                {address.slice(0, 6)}…{address.slice(-4)} connected
              </p>
              <button onClick={pay} disabled={paying} style={styles.button}>
                {payStatus === 'paying'
                  ? 'Confirm in wallet…'
                  : payStatus === 'verifying'
                    ? 'Verifying on Base…'
                    : `Pay ${quote.priceZer0} $ZER0 & run`}
              </button>
            </>
          )}
          {payError && <p style={styles.error}>{payError}</p>}
        </div>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    maxWidth: 640,
    margin: '0 auto',
    padding: '56px 24px',
    color: '#e6e9ef',
    fontFamily: '-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  },
  h1: { fontSize: 28, margin: '0 0 8px' },
  lead: { color: '#9aa4b8', margin: '0 0 24px', lineHeight: 1.6 },
  textarea: {
    width: '100%',
    background: '#121622',
    color: '#e6e9ef',
    border: '1px solid #232a3b',
    borderRadius: 12,
    padding: '12px 14px',
    fontSize: 15,
    resize: 'vertical',
  },
  button: {
    marginTop: 14,
    background: '#5eead4',
    color: '#0b0e14',
    border: 'none',
    borderRadius: 999,
    padding: '10px 22px',
    fontWeight: 700,
    fontSize: 15,
    cursor: 'pointer',
  },
  payBox: {
    marginTop: 24,
    padding: '18px 20px',
    background: '#121622',
    border: '1px solid #232a3b',
    borderRadius: 12,
  },
  payLine: { margin: '0 0 8px', lineHeight: 1.6 },
  addr: {
    margin: '4px 0 0',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    color: '#5eead4',
  },
  error: { color: '#ff6b6b', marginTop: 14, lineHeight: 1.6 },
};
