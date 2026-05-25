import type { TrackRecord } from '@/lib/stats/track-record';
import { signedUsd } from '@/lib/stats/format';

// Inline-SVG cumulative realized-PnL line — no chart dependency. Pure server
// component (no interactivity), so it renders straight into the page HTML.
export function CumulativePnlChart({
  data,
}: {
  data: TrackRecord['cumulativePnl'];
}) {
  if (data.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-[12px] text-zinc-600">
        not enough resolved calls yet — the curve appears once markets settle
      </div>
    );
  }

  const W = 600;
  const H = 160;
  const PAD = 10;
  const ys = data.map((d) => d.cumulativePnlUsd);
  const min = Math.min(0, ...ys);
  const max = Math.max(0, ...ys);
  const range = max - min || 1;
  const x = (i: number) => PAD + (i / (data.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - min) / range) * (H - 2 * PAD);

  const points = data.map((d, i) => `${x(i)},${y(d.cumulativePnlUsd)}`).join(' ');
  const last = ys[ys.length - 1];
  const up = last >= 0;
  const stroke = up ? 'rgb(110 231 183)' : 'rgb(253 164 175)'; // emerald-300 / rose-300
  const zeroY = y(0);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-40 w-full"
        role="img"
        aria-label="cumulative realized pnl"
      >
        {/* zero baseline */}
        <line
          x1={PAD}
          x2={W - PAD}
          y1={zeroY}
          y2={zeroY}
          stroke="rgb(255 255 255 / 0.12)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <polyline
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
        <span>{new Date(data[0].resolvedAt).toLocaleDateString()}</span>
        <span className={up ? 'text-emerald-300' : 'text-rose-300'}>
          {signedUsd(last)} cumulative
        </span>
        <span>{new Date(data[data.length - 1].resolvedAt).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
