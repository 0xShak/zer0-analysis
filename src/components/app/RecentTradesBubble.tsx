'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePopupAnchor } from './usePopupAnchor';

type RecentTrade = {
  id: string;
  market_condition_id: string;
  market_question: string | null;
  side: 'BUY' | 'SELL';
  price: number;
  size_usd: number;
  status: string;
  clob_order_id: string | null;
  failure_reason: string | null;
  submitted_at: string | null;
  created_at: string;
};

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case 'submitted':
      return {
        label: 'submitted',
        cls: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
      };
    case 'accepted':
      return {
        label: 'accepted',
        cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
      };
    case 'filled':
      return {
        label: 'filled',
        cls: 'bg-emerald-500/20 text-emerald-200 ring-emerald-500/40',
      };
    case 'rejected':
      return {
        label: 'rejected',
        cls: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
      };
    case 'failed':
      return {
        label: 'failed',
        cls: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
      };
    case 'cancelled':
      return {
        label: 'cancelled',
        cls: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30',
      };
    case 'prepared':
      return {
        label: 'prepared',
        cls: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
      };
    default:
      return {
        label: status,
        cls: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30',
      };
  }
}

export function RecentTradesBubble({ userAddress }: { userAddress?: string }) {
  const [open, setOpen] = useState(false);
  const [trades, setTrades] = useState<RecentTrade[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const anchor = usePopupAnchor(open, triggerRef);

  // One consolidated effect handles fetch-on-mount, fetch-on-event, and
  // open-window polling. Keeping all setState calls behind an `await` and
  // a `cancelled` guard avoids the react-hooks/set-state-in-effect lint —
  // and mirrors the pattern in ThoughtsBubble for consistency.
  useEffect(() => {
    if (!userAddress) return;
    let cancelled = false;

    async function fetchTrades() {
      try {
        const res = await fetch(
          `/api/trade/list?address=${encodeURIComponent(userAddress!)}`,
          { cache: 'no-store' },
        );
        if (cancelled) return;
        if (!res.ok) {
          setTrades([]);
          return;
        }
        const body = (await res.json()) as { trades?: RecentTrade[] };
        if (!cancelled) setTrades(body.trades ?? []);
      } catch {
        // Swallow — empty state covers the user-visible behavior.
      }
    }

    void fetchTrades();

    function onSubmitted() {
      void fetchTrades();
    }
    window.addEventListener('zer0:trade-submitted', onSubmitted);

    const polling = open ? setInterval(() => void fetchTrades(), 15_000) : null;

    return () => {
      cancelled = true;
      window.removeEventListener('zer0:trade-submitted', onSubmitted);
      if (polling) clearInterval(polling);
    };
  }, [userAddress, open]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !popupRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
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

  // Hide the button entirely until a wallet is connected — there's nothing
  // to show, and tapping it would be a dead end.
  if (!userAddress) return null;

  const popup =
    open && anchor
      ? createPortal(
          <div
            ref={popupRef}
            role="dialog"
            aria-label="recent trades on your wallet"
            style={{ top: anchor.top, right: anchor.right }}
            className="fixed z-[100] w-[22rem] overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.8)] sm:w-[26rem]"
          >
            <div className="flex items-baseline justify-between border-b border-white/[0.06] bg-zinc-950 px-4 py-2.5">
              <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-400">
                your trades
              </h3>
              <a
                href={`https://polymarket.com/profile/${userAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[10px] text-zinc-500 underline-offset-2 transition hover:text-zinc-300 hover:underline"
                title="open Polymarket profile in a new tab"
              >
                {userAddress.slice(0, 6)}…{userAddress.slice(-4)} ↗
              </a>
            </div>
            <ul className="max-h-[28rem] divide-y divide-white/[0.04] overflow-y-auto bg-zinc-950">
              {trades.length === 0 ? (
                <li className="px-4 py-6 text-center text-xs text-zinc-500">
                  no trades from this wallet yet.
                </li>
              ) : (
                trades.map((t) => {
                  const sb = statusBadge(t.status);
                  return (
                    <li key={t.id} className="px-4 py-3">
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <p className="line-clamp-2 text-[12px] font-medium leading-snug text-zinc-100">
                          {t.market_question ?? '(unknown market)'}
                        </p>
                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1 ${sb.cls}`}
                        >
                          {sb.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-500">
                        <span
                          className={
                            t.side === 'BUY'
                              ? 'text-emerald-300/80'
                              : 'text-rose-300/80'
                          }
                        >
                          {t.side} @ {Number(t.price).toFixed(2)}
                        </span>
                        <span className="h-0.5 w-0.5 rounded-full bg-zinc-700" />
                        <span>${Number(t.size_usd).toFixed(2)}</span>
                        <span className="h-0.5 w-0.5 rounded-full bg-zinc-700" />
                        <span>{relTime(t.submitted_at ?? t.created_at)}</span>
                      </div>
                      {t.failure_reason ? (
                        <p className="mt-1 text-[10px] text-rose-400">
                          {t.failure_reason}
                        </p>
                      ) : t.clob_order_id ? (
                        <p className="mt-1 truncate font-mono text-[10px] text-zinc-500">
                          order {t.clob_order_id}
                        </p>
                      ) : null}
                    </li>
                  );
                })
              )}
            </ul>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-label="recent trades on your wallet"
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
          <path d="M4 6h16" />
          <path d="M4 12h10" />
          <path d="M4 18h7" />
          <circle cx="18" cy="17" r="3" />
          <path d="M18 14v3l2 1" />
        </svg>
        {badge ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-semibold text-black">
            {badge}
          </span>
        ) : null}
      </button>
      {popup}
    </>
  );
}
