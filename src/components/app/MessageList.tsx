'use client';

import { useEffect, useRef } from 'react';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
};

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 overflow-y-auto px-4 py-6 sm:px-6">
      {messages.map((m) => (
        <div
          key={m.id}
          className={
            m.role === 'user' ? 'flex justify-end' : 'flex justify-start'
          }
        >
          <div
            className={
              m.role === 'user'
                ? 'max-w-[80%] rounded-2xl rounded-br-md bg-emerald-600 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm'
                : 'max-w-[85%] rounded-2xl rounded-bl-md border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm leading-relaxed text-zinc-100 backdrop-blur-md'
            }
          >
            <span
              className={
                m.role === 'assistant' && m.streaming ? 'typing-cursor' : ''
              }
            >
              {m.content || (m.streaming ? '' : ' ')}
            </span>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
