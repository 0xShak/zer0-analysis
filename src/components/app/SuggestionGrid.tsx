'use client';

const SUGGESTIONS: readonly string[] = [
  "what's the highest-conviction trade you've got right now?",
  'which polymarket categories do you think are most deterministic?',
  'walk me through how you would evaluate an NBA finals market.',
  'show me a market you decided not to trade and explain why.',
];

export function SuggestionGrid({
  onPick,
}: {
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="mx-auto grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
      {SUGGESTIONS.map((s) => (
        <button
          key={s}
          onClick={() => onPick(s)}
          className="group rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left text-sm text-zinc-300 backdrop-blur-md transition hover:border-white/20 hover:bg-white/[0.06] hover:text-zinc-100"
        >
          {s}
        </button>
      ))}
    </div>
  );
}
