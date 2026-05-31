'use client';

import { forwardRef, useImperativeHandle, useState } from 'react';
import { MessageInput } from './MessageInput';
import { MessageList, type ChatMessage } from './MessageList';
import { Welcome } from './Welcome';

export type ChatPanelHandle = {
  reset: () => void;
};

type Paywall = { unlocked: boolean } | null;

// Where to send a rate-limited user to buy PRO (the zer0-FE pricing page).
const PRICING_URL =
  process.env.NEXT_PUBLIC_PRICING_URL ?? 'https://atzer0.xyz/#price';

let mid = 0;
const nextId = () => `m_${Date.now()}_${++mid}`;

async function consumeSseStream(
  res: Response,
  onDelta: (delta: string) => void,
  onError: (err: string) => void,
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') return;
        try {
          const obj = JSON.parse(payload) as {
            delta?: string;
            error?: string;
          };
          if (obj.error) onError(obj.error);
          else if (obj.delta) onDelta(obj.delta);
        } catch {
          // ignore malformed frame
        }
      }
    }
  }
}

export const ChatPanel = forwardRef<
  ChatPanelHandle,
  { onMessageSent?: () => void; walletAddress?: string }
>(function ChatPanel({ onMessageSent, walletAddress }, ref) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [paywall, setPaywall] = useState<Paywall>(null);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      reset: () => {
        setMessages([]);
        setSessionId(undefined);
        setPaywall(null);
        setError(null);
      },
    }),
    [],
  );

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setError(null);
    setBusy(true);

    const userMsg: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: text,
    };
    const assistantId = nextId();
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: 'assistant' as const, content: '', streaming: true },
    ]);
    onMessageSent?.();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Lets a PRO unlock paid from the connected wallet be recognized here.
          ...(walletAddress ? { 'x-wallet-address': walletAddress } : {}),
        },
        body: JSON.stringify({ message: text, session_id: sessionId }),
      });

      const returnedSid = res.headers.get('x-zer0-session-id');
      if (returnedSid) setSessionId(returnedSid);

      if (res.status === 402) {
        const json = (await res.json().catch(() => ({}))) as {
          paywall?: boolean;
        };
        if (json.paywall) {
          setPaywall({ unlocked: false });
          // drop the empty assistant placeholder
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        }
        return;
      }

      if (!res.ok) {
        throw new Error(`chat ${res.status}`);
      }

      await consumeSseStream(
        res,
        (delta) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content + delta }
                : m,
            ),
          );
        },
        (err) => setError(err),
      );

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, streaming: false } : m,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, streaming: false } : m,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const showWelcome = messages.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showWelcome ? (
        <Welcome onPick={(p) => void send(p)} />
      ) : (
        <MessageList messages={messages} />
      )}

      {paywall ? (
        <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
          <div className="glass mb-3 rounded-2xl px-4 py-3 text-sm text-zinc-200">
            you&apos;ve hit the daily chat limit.{' '}
            <a
              href={PRICING_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-emerald-400 underline-offset-2 hover:underline"
            >
              unlock 30 days with $ZER0 →
            </a>
            <span className="block text-xs text-zinc-500">
              pay with $ZER0 on Base, then connect that same wallet here.
            </span>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
          <div className="mb-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        </div>
      ) : null}

      <MessageInput
        onSend={(t) => void send(t)}
        disabled={busy || !!paywall}
      />
    </div>
  );
});
