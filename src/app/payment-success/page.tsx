import Link from 'next/link';

export default function PaymentSuccess() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-black text-zinc-100">
      <div className="max-w-md text-center">
        <h1 className="mb-3 text-3xl font-bold">Payment received</h1>
        <p className="mb-6 text-zinc-400">
          Your 30 days of unlimited ZER0 access are active. Webhook confirmation may
          take a few seconds — refresh if chat is still gated.
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
