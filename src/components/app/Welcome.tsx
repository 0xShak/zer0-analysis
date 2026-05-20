'use client';

import Image from 'next/image';
import { SuggestionGrid } from './SuggestionGrid';

export function Welcome({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-10">
      <div className="mb-6 h-14 w-14 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-md">
        <Image
          src="/zer0-img.png"
          alt="zer0"
          width={56}
          height={56}
          className="h-full w-full object-cover"
          priority
        />
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
