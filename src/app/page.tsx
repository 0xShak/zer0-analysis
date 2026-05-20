import Image from 'next/image';
import Link from 'next/link';

export default function Home() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="mb-8 h-16 w-16 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-md">
        <Image
          src="/zer0-img.png"
          alt="zer0"
          width={64}
          height={64}
          className="h-full w-full object-cover"
          priority
        />
      </div>

      <h1 className="mb-3 text-5xl font-semibold tracking-tight text-zinc-50 sm:text-6xl">
        ZER<span className="italic text-zinc-400">0</span>
      </h1>

      <p className="mx-auto mb-10 max-w-md text-base leading-relaxed text-zinc-400">
        an autonomous AI watching polymarket for deterministic-outcome trades.
        ask it anything — see what it&apos;s thinking in real time.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/app"
          className="group inline-flex items-center gap-2 rounded-full bg-zinc-50 px-5 py-2.5 text-sm font-medium text-black transition hover:bg-white"
        >
          open the app
          <span className="transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </Link>
        <a
          href="https://t.me/zer0_bot"
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-zinc-200 backdrop-blur-md transition hover:border-white/20 hover:bg-white/[0.06]"
        >
          telegram bot
        </a>
      </div>

      <footer className="absolute bottom-6 left-0 right-0 text-center text-xs text-zinc-600">
        no signup. no custody. your wallet stays yours.
      </footer>
    </main>
  );
}
