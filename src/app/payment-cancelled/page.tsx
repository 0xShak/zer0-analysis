import Link from 'next/link';

export default function PaymentCancelled() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-black text-zinc-100">
      <div className="max-w-md text-center">
        <h1 className="mb-3 text-3xl font-bold">Payment cancelled</h1>
        <p className="mb-6 text-zinc-400">
          No charge was made. You can keep chatting up to the anonymous limit and
          retry whenever you&apos;re ready.
        </p>
        <Link
          href="/app"
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          Back to the app
        </Link>
      </div>
    </main>
  );
}
