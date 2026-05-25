import Link from 'next/link';
import Image from 'next/image';
import { computeTrackRecord } from '@/lib/stats/track-record';
import { TrackRecordCards } from '@/components/app/TrackRecordCards';
import { CumulativePnlChart } from '@/components/app/CumulativePnlChart';
import { CalibrationBars } from '@/components/app/CalibrationBars';
import { CategoryBreakdown } from '@/components/app/CategoryBreakdown';
import {
  ResolvedList,
  OpenPositionsList,
} from '@/components/app/TrackRecordLists';

// Reads live data via the service-role client at request time, so never
// prerender / cache this route.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'zer0 · track record',
};

function Panel({
  title,
  subtitle,
  children,
  className = '',
  bodyClassName = 'p-4',
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={`overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.8)] ${className}`}
    >
      <header className="border-b border-white/[0.06] px-4 py-2.5">
        <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-400">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-0.5 text-[11px] text-zinc-600">{subtitle}</p>
        ) : null}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export default async function StatsPage() {
  const data = await computeTrackRecord();

  return (
    <main className="h-screen w-full overflow-y-auto bg-black">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-black/30 px-4 py-3 backdrop-blur-sm sm:px-6">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 overflow-hidden rounded-full border border-white/10 bg-white/[0.04]">
            <Image
              src="/zer0-img.png"
              alt="zer0"
              width={32}
              height={32}
              className="h-full w-full object-cover"
            />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-zinc-100">
              track record
            </span>
            <span className="text-[11px] text-zinc-500">
              how zer0&apos;s calls have played out
            </span>
          </div>
        </div>
        <Link
          href="/app"
          className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.06]"
        >
          ← back to chat
        </Link>
      </header>

      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6">
        <TrackRecordCards data={data} />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Panel
            title="cumulative pnl"
            subtitle="realized, paper — following every resolved call"
            className="lg:col-span-2"
          >
            <CumulativePnlChart data={data.cumulativePnl} />
          </Panel>
          <Panel title="calibration" subtitle="win rate by conviction">
            <CalibrationBars data={data.calibration} />
          </Panel>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="by category">
            <CategoryBreakdown data={data.byCategory} />
          </Panel>
          <Panel
            title="open positions"
            subtitle={`${data.open.count} live · marked to current price`}
            bodyClassName=""
          >
            <OpenPositionsList data={data.openPositions} />
          </Panel>
        </div>

        <Panel title="recently resolved" bodyClassName="">
          <ResolvedList data={data.recentResolved} />
        </Panel>

        <p className="px-1 pb-4 text-[11px] leading-relaxed text-zinc-600">
          Paper track record: hypothetical PnL from following each call at its
          suggested price and size — not per-wallet realized PnL. Outcomes use
          Polymarket resolution (a token settling to ~1); ambiguous/refunded
          markets are excluded as void. Conviction buckets are a calibration
          proxy, not calibrated probabilities.
        </p>
      </div>
    </main>
  );
}
