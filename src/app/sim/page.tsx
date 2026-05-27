'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Minimal web trigger for run-a-sim. Posts the scenario to /api/sim and
// navigates to /sim/<pending_sim_id> to watch it run. Deliberately tiny — v1
// reuses MiroShark's own watch + share-card pages for the result (§1).

export default function SimTriggerPage() {
  const router = useRouter();
  const [scenario, setScenario] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ priceZer0: string } | null>(null);

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
        // Web payment UX (WalletConnect on Base) ships with the payment gate.
        setQuote(data.quote);
        return;
      }
      router.push(`/sim/${data.pending_sim_id}`);
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

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
        disabled={busy}
      />
      <button onClick={submit} disabled={busy} style={styles.button}>
        {busy ? 'Starting…' : 'Run sim'}
      </button>
      {error && <p style={styles.error}>{error}</p>}
      {quote && (
        <p style={styles.note}>
          This sim costs {quote.priceZer0} $ZER0 on Base. Connect a wallet to
          pay — web payment is rolling out shortly.
        </p>
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
  error: { color: '#ff6b6b', marginTop: 14 },
  note: { color: '#ffd166', marginTop: 14, lineHeight: 1.6 },
};
