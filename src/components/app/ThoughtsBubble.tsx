'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createClient } from '@/lib/supabase/client';
import { usePopupAnchor } from './usePopupAnchor';

type Thought = {
  id: number;
  content: string;
  created_at: string;
  market_condition_id: string | null;
};

const LAST_SEEN_KEY = 'zer0:lastSeenThoughtId';

function readLastSeen(): number {
  if (typeof window === 'undefined') return 0;
  const raw = window.localStorage.getItem(LAST_SEEN_KEY);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

function writeLastSeen(id: number) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LAST_SEEN_KEY, String(id));
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function ThoughtsBubble() {
  const [open, setOpen] = useState(false);
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [lastSeen, setLastSeen] = useState<number>(() => readLastSeen());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const anchor = usePopupAnchor(open, triggerRef);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    void (async () => {
      const { data } = await supabase
        .from('thoughts')
        .select('id, content, created_at, market_condition_id')
        .eq('scope', 'app')
        .order('created_at', { ascending: false })
        .limit(20);
      if (!cancelled && data) setThoughts(data as Thought[]);
    })();

    const channel = supabase
      .channel('thoughts:app')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'thoughts',
          filter: 'scope=eq.app',
        },
        ({ new: row }) => {
          setThoughts((prev) => [row as Thought, ...prev].slice(0, 20));
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

  const unread = thoughts.reduce((n, t) => (t.id > lastSeen ? n + 1 : n), 0);
  const badge =
    unread === 0 ? null : unread > 5 ? '5+' : String(unread);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && thoughts[0]) {
      writeLastSeen(thoughts[0].id);
      setLastSeen(thoughts[0].id);
    }
  }

  const popup = open && anchor
    ? createPortal(
        <div
          ref={popupRef}
          role="dialog"
          aria-label="zer0's recent thoughts"
          style={{ top: anchor.top, right: anchor.right }}
          className="fixed z-[100] w-80 overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.8)] sm:w-96"
        >
          <div className="border-b border-white/[0.06] bg-zinc-950 px-4 py-2.5">
            <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-400">
              thoughts
            </h3>
          </div>
          <ul className="max-h-96 divide-y divide-white/[0.04] overflow-y-auto bg-zinc-950">
            {thoughts.length === 0 ? (
              <li className="px-4 py-6 text-center text-xs text-zinc-500">
                zer0 hasn&apos;t emitted any thoughts yet.
              </li>
            ) : (
              thoughts.slice(0, 5).map((t) => (
                <li key={t.id} className="px-4 py-3">
                  <p className="text-sm leading-snug text-zinc-200">
                    {t.content}
                  </p>
                  <p className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">
                    {relTime(t.created_at)}
                  </p>
                </li>
              ))
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
        onClick={toggle}
        aria-label="zer0's thoughts"
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
          <path d="M12 3a4 4 0 0 0-3.6 5.7A4 4 0 0 0 6 14a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4 4 4 0 0 0-2.4-5.3A4 4 0 0 0 12 3Z" />
          <path d="M12 18v3" />
          <path d="M9 21h6" />
        </svg>
        {badge ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-black">
            {badge}
          </span>
        ) : null}
      </button>
      {popup}
    </>
  );
}
