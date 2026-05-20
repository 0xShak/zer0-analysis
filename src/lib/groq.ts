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
export const GROQ_MODELS = {
  CHAT: 'llama-3.3-70b-versatile',
  CLASSIFIER: 'llama-3.1-8b-instant',
} as const;
