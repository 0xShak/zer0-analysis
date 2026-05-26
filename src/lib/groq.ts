import Groq from 'groq-sdk';
import { env } from './env';

let cached: Groq | undefined;

export function getGroq(): Groq {
  if (cached) return cached;
  // Free-tier Groq is 30 RPM. The SDK defaults to maxRetries=2 AND honors the
  // 429 Retry-After header (often 30s), which means a single rate-limited call
  // can sleep 30-90s INSIDE a Promise.all — pinning the whole batch and
  // blowing the Vercel function budget. Fail fast instead: surface 429s
  // immediately, let Inngest retry the step or let next tick recover.
  cached = new Groq({
    apiKey: env.GROQ_API_KEY,
    timeout: 15_000,
    maxRetries: 0,
  });
  return cached;
}

// Models referenced by zer0.md.
//
// CHAT was llama-3.3-70b-versatile, but Groq's free tier tracks rate limits
// PER MODEL, and the 70B bucket is only ~1,000 requests/day vs ~14,400/day for
// 8B-instant — a separate, 14x-larger pool. With the Developer (paid) tier
// upgrade unavailable, the 70B chat path 429'd constantly and left Telegram
// users stuck on "Typing…" with no reply. Moving chat to 8B keeps it running
// on free tier for $0. NB: the per-minute token ceiling (~6k TPM) is identical
// across both models, so this change alone isn't enough — we also trimmed the
// chat prompt (see chat/context.ts) and capped max_tokens so a single call
// stays well under the per-minute window.
export const GROQ_MODELS = {
  CHAT: 'llama-3.1-8b-instant',
  CLASSIFIER: 'llama-3.1-8b-instant',
} as const;
