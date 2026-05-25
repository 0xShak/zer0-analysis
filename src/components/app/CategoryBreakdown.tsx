import type { TrackRecord } from '@/lib/stats/track-record';
import { pct, signedUsd, pnlColor } from '@/lib/stats/format';

// Resolved-call performance split by market category (sports/election/etc).
export function CategoryBreakdown({
  data,
}: {
  data: TrackRecord['byCategory'];
}) {
  if (data.length === 0) {
    return (
      <p className="text-[12px] text-zinc-600">
        no resolved calls yet — category breakdown appears after settlement.
      </p>
    );
  }

  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-zinc-500">
          <th className="pb-2 font-medium">category</th>
          <th className="pb-2 text-right font-medium">calls</th>
          <th className="pb-2 text-right font-medium">win rate</th>
          <th className="pb-2 text-right font-medium">pnl</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-white/[0.04]">
        {data.map((row) => (
          <tr key={row.category}>
            <td className="py-2 text-zinc-300">{row.category}</td>
            <td className="py-2 text-right text-zinc-400">{row.n}</td>
            <td className="py-2 text-right text-zinc-300">{pct(row.winRate)}</td>
            <td className={`py-2 text-right font-medium ${pnlColor(row.realizedPnlUsd)}`}>
              {signedUsd(row.realizedPnlUsd)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
