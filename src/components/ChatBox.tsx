'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type Message = { id: number; role: string; content: string; created_at: string };

export function ChatBox({ walletAddress }: { walletAddress?: string }) {
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [paywall, setPaywall] = useState<{ hosted_url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`chat:${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `session_id=eq.${sessionId}` },
        ({ new: row }) => {
          setMessages((prev) => [...prev, row as Message]);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [sessionId]);

  async function send() {
    if (!input.trim() || busy) return;
    setBusy(true);
    const content = input;
    setInput('');
    setMessages((prev) => [
      ...prev,
      { id: Date.now(), role: 'user', content, created_at: new Date().toISOString() },
    ]);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, sessionId, walletAddress }),
      });
      const json = await res.json();
      if (res.status === 402 && json.paywall) {
        setPaywall({ hosted_url: json.hosted_url });
      } else if (json.sessionId) {
        setSessionId(json.sessionId);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'text-right' : ''}>
            <div
              className={`inline-block max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                m.role === 'user'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-zinc-800 text-zinc-100'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
      </div>
      {paywall ? (
        <div className="border-t border-zinc-800 p-4 text-sm text-zinc-200">
          You&apos;ve hit the anonymous chat limit.{' '}
          <a
            href={paywall.hosted_url}
            className="text-emerald-400 underline"
            target="_blank"
            rel="noreferrer"
          >
            Unlock 30 days for $5 USDC →
          </a>
        </div>
      ) : (
        <div className="border-t border-zinc-800 p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask ZER0…"
              className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
