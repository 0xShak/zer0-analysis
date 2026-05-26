import type { TrackRecord } from '@/lib/stats/track-record';
import { pct } from '@/lib/stats/format';

// Win rate per conviction bucket. If ZER0 is well-calibrated, higher-conviction
// buckets should win more often. Bars reuse the sidebar meter look.
export function CalibrationBars({
  data,
}: {
  data: TrackRecord['calibration'];
}) {
  const hasAny = data.some((b) => b.n > 0);
  if (!hasAny) {
    return (
      <p className="text-[12px] text-zinc-600">
        no resolved calls yet — calibration fills in as markets settle.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {data.map((b) => {
        const ratio = b.winRate ?? 0;
        return (
          <li key={b.label}>
            <div className="mb-1 flex items-baseline justify-between text-[11px]">
              <span className="font-mono text-zinc-400">{b.label}</span>
              <span className="text-zinc-500">
                {b.n === 0 ? 'no calls' : `${pct(b.winRate)} of ${b.n}`}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full bg-emerald-500/70"
                style={{ width: `${ratio * 100}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
