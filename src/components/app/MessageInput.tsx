'use client';

import { useEffect, useRef, useState } from 'react';

export function MessageInput({
  onSend,
  disabled,
  placeholder = 'ask zer0…',
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [value]);

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-6 pt-2 sm:px-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="glass-strong relative flex items-end gap-2 rounded-3xl px-4 py-3 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.6)]"
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={disabled}
          placeholder={placeholder}
          className="flex-1 resize-none bg-transparent text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          aria-label="send"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-50 text-black transition hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 19V5" />
            <path d="M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
      <p className="mt-2 text-center text-[11px] text-zinc-600">
        zer0 can be wrong. it never holds your funds.
      </p>
    </div>
  );
}
