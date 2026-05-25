import type { TrackRecord } from '@/lib/stats/track-record';
import { signedUsd, pct, pnlColor } from '@/lib/stats/format';

function Badge({
  tone,
  children,
}: {
  tone: 'win' | 'loss' | 'up' | 'down';
  children: React.ReactNode;
}) {
  const cls =
    tone === 'win' || tone === 'up'
      ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
      : 'bg-rose-500/15 text-rose-300 ring-rose-500/30';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ring-1 ${cls}`}
    >
      {children}
    </span>
  );
}

export function ResolvedList({ data }: { data: TrackRecord['recentResolved'] }) {
  if (data.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-[12px] text-zinc-600">
        no calls have resolved yet. most markets ZER0 calls are weeks out — check
        the open positions above in the meantime.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-white/[0.04]">
      {data.map((r) => (
        <li key={r.id} className="flex items-center gap-3 px-4 py-3">
          <Badge tone={r.status === 'won' ? 'win' : 'loss'}>
            {r.status === 'won' ? 'hit' : 'miss'}
          </Badge>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-zinc-200">{r.question}</p>
            <p className="text-[11px] text-zinc-500">
              {r.side} · conviction {pct(r.conviction)}
              {r.resolvedAt
                ? ` · ${new Date(r.resolvedAt).toLocaleDateString()}`
                : ''}
            </p>
          </div>
          <span className={`shrink-0 text-[13px] font-medium ${pnlColor(r.realizedPnlUsd)}`}>
            {signedUsd(r.realizedPnlUsd)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function OpenPositionsList({
  data,
}: {
  data: TrackRecord['openPositions'];
}) {
  if (data.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-[12px] text-zinc-600">
        no open positions. once ZER0 logs a recommendation and the settle job
        marks it, it shows here.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-white/[0.04]">
      {data.map((r) => (
        <li key={r.id} className="flex items-center gap-3 px-4 py-3">
          <Badge tone={r.inMoney ? 'up' : 'down'}>
            {r.inMoney ? 'in $' : 'out'}
          </Badge>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-zinc-200">{r.question}</p>
            <p className="text-[11px] text-zinc-500">
              {r.side} · conviction {pct(r.conviction)}
            </p>
          </div>
          <span className={`shrink-0 text-[13px] font-medium ${pnlColor(r.markPnlUsd)}`}>
            {r.markPnlUsd === null ? 'not marked' : signedUsd(r.markPnlUsd)}
          </span>
        </li>
      ))}
    </ul>
  );
}
