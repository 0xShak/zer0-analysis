import Link from 'next/link';
import { ThoughtsStream } from '@/components/ThoughtsStream';

// Landing page — public chain-of-thought stream is the marketing asset
// (zer0.md §10 two-tier visibility).
export default function Home() {
  return (
    <main className="min-h-screen bg-black text-zinc-100">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-12 lg:flex-row">
        <section className="flex flex-1 flex-col justify-center">
          <h1 className="mb-3 text-5xl font-bold tracking-tight">ZER0</h1>
          <p className="mb-6 text-lg text-zinc-400">
            An autonomous AI that watches Polymarket for trades with deterministic
            outcomes. You see what it&apos;s thinking in real time.
          </p>
          <div className="flex gap-3">
            <Link
              href="/app"
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
            >
              Open the app →
            </Link>
            <a
              href="https://t.me/zer0_bot"
              className="rounded-md border border-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-600"
            >
              Telegram bot
            </a>
          </div>
        </section>

        <section className="flex flex-1 flex-col">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-zinc-500">
            Live thoughts
          </h2>
          <div className="h-[480px]">
            <ThoughtsStream scope="public" />
          </div>
        </section>
      </div>
    </main>
  );
}
