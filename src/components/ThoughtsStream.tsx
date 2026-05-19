'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type Thought = {
  id: number;
  content: string;
  created_at: string;
  market_condition_id: string | null;
};

export function ThoughtsStream({ scope }: { scope: 'public' | 'app' }) {
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    void (async () => {
      const { data } = await supabase
        .from('thoughts')
        .select('id, content, created_at, market_condition_id')
        .eq('scope', scope)
        .order('created_at', { ascending: false })
        .limit(50);
      if (!cancelled && data) setThoughts(data.reverse());
    })();

    const channel = supabase
      .channel(`thoughts:${scope}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'thoughts', filter: `scope=eq.${scope}` },
        ({ new: row }) => {
          setThoughts((prev) => [...prev.slice(-49), row as Thought]);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [scope]);

  useEffect(() => {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  }, [thoughts]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm font-mono text-zinc-300"
    >
      {thoughts.length === 0 ? (
        <p className="text-zinc-600">ZER0 is warming up…</p>
      ) : (
        <ul className="space-y-2">
          {thoughts.map((t) => (
            <li key={t.id} className="leading-snug">
              <span className="text-zinc-500">
                {new Date(t.created_at).toLocaleTimeString()}
              </span>{' '}
              {t.content}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
