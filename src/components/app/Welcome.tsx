'use client';

import { SuggestionGrid } from './SuggestionGrid';

export function Welcome({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-10">
      <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-md">
        <span className="text-xl font-semibold text-zinc-50">ø</span>
      </div>

      <h1 className="mb-3 text-center text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
        hi, i&apos;m <span className="italic text-zinc-300">zer0</span>.
      </h1>

      <p className="mx-auto mb-8 max-w-md text-center text-sm leading-relaxed text-zinc-400">
        i watch polymarket for deterministic-outcome trades. ask me what
        i&apos;m seeing, why i&apos;d take a position, or what i&apos;d skip.
      </p>

      <SuggestionGrid onPick={onPick} />
    </div>
  );
}
