import type { TrackRecord } from '@/lib/stats/track-record';
import { usd, signedUsd, pct, pnlColor } from '@/lib/stats/format';

function Card({
  label,
  value,
  sub,
  valueClass = 'text-zinc-100',
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition hover:border-white/[0.12] hover:bg-white/[0.04]">
      <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
        {label}
      </p>
      <p className={`mt-1.5 text-2xl font-semibold tracking-tight ${valueClass}`}>
        {value}
      </p>
      {sub ? <p className="mt-1 text-[11px] text-zinc-500">{sub}</p> : null}
    </div>
  );
}

export function TrackRecordCards({ data }: { data: TrackRecord }) {
  const { realized, open, counts } = data;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Card
        label="win rate"
        value={pct(realized.winRate)}
        sub={`${realized.wins}W · ${realized.losses}L`}
      />
      <Card
        label="realized pnl"
        value={signedUsd(realized.pnlUsd)}
        valueClass={pnlColor(realized.pnlUsd)}
        sub={`on ${usd(realized.stakedUsd)} staked`}
      />
      <Card
        label="roi"
        value={realized.roi === null ? '—' : pct(realized.roi, 1)}
        valueClass={pnlColor(realized.roi)}
        sub="realized return"
      />
      <Card
        label="open pnl"
        value={signedUsd(open.unrealizedPnlUsd)}
        valueClass={pnlColor(open.unrealizedPnlUsd)}
        sub={`${open.inMoneyCount}/${open.count} in the money`}
      />
      <Card
        label="calls"
        value={String(counts.total)}
        sub={`${counts.resolved} resolved · ${counts.open} open${
          counts.void ? ` · ${counts.void} void` : ''
        }`}
      />
    </div>
  );
}
