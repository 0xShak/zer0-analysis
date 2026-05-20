import Link from 'next/link';

export default function PaymentCancelled() {
  return (
    <main className="relative flex min-h-screen items-center justify-center px-6">
      <div className="glass max-w-md rounded-2xl px-8 py-10 text-center">
        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-50">
          payment cancelled
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-zinc-400">
          no charge was made. you can keep chatting up to the anonymous limit
          and retry whenever you&apos;re ready.
        </p>
        <Link
          href="/app"
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
        >
          back to the app →
        </Link>
      </div>
    </main>
  );
}
