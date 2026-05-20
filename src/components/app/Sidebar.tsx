'use client';

import Link from 'next/link';

const DAILY_FREE_MESSAGES = 5;

export function Sidebar({
  messagesUsed,
  walletConnected,
  onNewChat,
}: {
  messagesUsed: number;
  walletConnected: boolean;
  onNewChat: () => void;
}) {
  const limit = walletConnected ? 20 : DAILY_FREE_MESSAGES;
  const ratio = Math.min(1, messagesUsed / limit);

  return (
    <aside className="flex h-full flex-col border-r border-white/[0.06] bg-black/40 px-4 py-5 backdrop-blur-sm">
      <header className="mb-5 flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]">
          <span className="text-sm font-semibold text-zinc-50">ø</span>
        </div>
        <span className="text-sm font-semibold tracking-tight text-zinc-100">
          zer0
        </span>
      </header>

      <button
        onClick={onNewChat}
        className="mb-6 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.06]"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        new chat
      </button>

      <section className="mb-6">
        <h2 className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
          about
        </h2>
        <p className="text-xs leading-relaxed text-zinc-400">
          zer0 watches polymarket for trades with deterministic outcomes. it
          never holds your funds — orders sign in your wallet, route to the CLOB
          directly.
        </p>
      </section>

      <div className="flex-1" />

      <section className="mb-4">
        <h2 className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
          usage
        </h2>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-lg font-semibold text-zinc-100">
            {messagesUsed}
            <span className="text-zinc-500">/{limit}</span>
          </span>
          <span className="text-[11px] text-zinc-500">messages</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-white/5">
          <div
            className="h-full rounded-full bg-emerald-500/70 transition-all"
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      </section>

      <Link
        href="/"
        className="text-xs text-zinc-500 transition hover:text-zinc-300"
      >
        ← back to home
      </Link>
    </aside>
  );
}
