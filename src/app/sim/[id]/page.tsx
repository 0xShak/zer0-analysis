'use client';

import { use, useEffect, useRef, useState } from 'react';

// Result view for a sim. Polls /api/sim/[id] until the run completes, then
// renders MiroShark's own share card + a link to its live /watch page — zero
// custom result UI in v1 (§1). `id` is the pending_sim id.

interface SimStatus {
  state: string;
  needs_payment: boolean;
  scenario: string;
  simulation: {
    status: string;
    watch_url: string | null;
    share_card_url: string | null;
    summary: string | null;
    error: string | null;
    completed_at: string | null;
  } | null;
}

const TERMINAL = ['COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED'];
const POLL_MS = 4000;

export default function SimResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [status, setStatus] = useState<SimStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const res = await fetch(`/api/sim/${id}`, { cache: 'no-store' });
        if (!res.ok) {
          if (res.status === 404) setError('Sim not found.');
          return;
        }
        const data: SimStatus = await res.json();
        if (stopped) return;
        setStatus(data);
        const done =
          TERMINAL.includes(data.state) ||
          (data.simulation && TERMINAL.includes(data.simulation.status));
        if (done && timer.current) {
          clearInterval(timer.current);
          timer.current = null;
        }
      } catch {
        /* transient — next tick retries */
      }
    }
    void poll();
    timer.current = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, [id]);

  const sim = status?.simulation;
  const completed = sim?.status === 'COMPLETED';
  const failed =
    status?.state === 'FAILED' || sim?.status === 'FAILED';

  return (
    <main style={styles.wrap}>
      <h1 style={styles.h1}>Swarm sim</h1>
      {status?.scenario && <p style={styles.scenario}>{status.scenario}</p>}

      {error && <p style={styles.error}>{error}</p>}

      {!error && !completed && !failed && (
        <>
          <p style={styles.status}>
            {status?.state === 'AWAITING_PAYMENT'
              ? 'Waiting for payment…'
              : 'Running the swarm… this takes a few minutes. This page updates itself.'}
          </p>
          {/* sim-run publishes + hands back watch_url the moment the run starts,
              so the live link can show mid-run — no need to wait for completion. */}
          {sim?.watch_url && status?.state !== 'AWAITING_PAYMENT' && (
            <p>
              <a
                href={sim.watch_url}
                target="_blank"
                rel="noreferrer"
                style={styles.link}
              >
                ▶ Watch it live
              </a>
            </p>
          )}
        </>
      )}

      {failed && (
        <p style={styles.error}>
          {sim?.error ?? 'The simulation failed. Try running it again.'}
        </p>
      )}

      {completed && sim && (
        <div>
          {sim.summary && <p style={styles.summary}>{sim.summary}</p>}
          {sim.share_card_url && (
            // MiroShark renders the share card; we just embed it.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={sim.share_card_url}
              alt="Simulation share card"
              style={styles.card}
            />
          )}
          {sim.watch_url && (
            <p>
              <a href={sim.watch_url} target="_blank" rel="noreferrer" style={styles.link}>
                ▶ Watch the full run
              </a>
            </p>
          )}
        </div>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    maxWidth: 720,
    margin: '0 auto',
    padding: '56px 24px',
    color: '#e6e9ef',
    fontFamily: '-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  },
  h1: { fontSize: 28, margin: '0 0 8px' },
  scenario: { color: '#9aa4b8', margin: '0 0 24px', lineHeight: 1.6, fontStyle: 'italic' },
  status: { color: '#7c9cff', lineHeight: 1.6 },
  summary: { fontSize: 17, lineHeight: 1.7, margin: '0 0 20px' },
  card: {
    width: '100%',
    borderRadius: 12,
    border: '1px solid #232a3b',
    margin: '0 0 16px',
  },
  link: { color: '#5eead4' },
  error: { color: '#ff6b6b', lineHeight: 1.6 },
};
