import OpenAI from 'openai';
import { env } from '../env';

let cached: OpenAI | undefined;

export function getOpenAI(): OpenAI {
  if (cached) return cached;
  // 50s request timeout: must be safely under our Vercel maxDuration (60s on
  // the /api/inngest route) so a slow gpt-5.5-pro reasoning call fails fast
  // and the Inngest step can surface a retryable error, rather than getting
  // killed by Vercel mid-call (which leaves the step in a stuck "Running"
  // state with no clean error surface).
  cached = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    timeout: 50_000,
    maxRetries: 1,
  });
  return cached;
}

// Default analyzer model; override via env. See openai-pricing.ts for the
// pricing table that must contain whatever model the env points at.
export const ANALYZER_MODEL: string = process.env.ANALYZER_MODEL || 'gpt-5.5-pro';

// TODO(v1.1): consider enabling OpenAI native web-search tool for fresher
// news context. Adds cost — measure signal-quality lift first.
