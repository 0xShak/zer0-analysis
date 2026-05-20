import Link from 'next/link';

export default function PaymentSuccess() {
  return (
    <main className="relative flex min-h-screen items-center justify-center px-6">
      <div className="glass max-w-md rounded-2xl px-8 py-10 text-center">
        <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30">
          <span className="text-2xl text-emerald-300">✓</span>
        </div>
        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-50">
          payment received
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-zinc-400">
          your 30 days of unlimited zer0 access are active. webhook confirmation
          may take a few seconds — refresh if chat is still gated.
        </p>
        <Link
          href="/app"
          className="inline-flex items-center gap-2 rounded-full bg-zinc-50 px-5 py-2.5 text-sm font-medium text-black transition hover:bg-white"
        >
          back to the app →
        </Link>
      </div>
    </main>
  );
}
