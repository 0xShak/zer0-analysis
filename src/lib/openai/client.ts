import OpenAI from 'openai';
import { env } from '../env';

let cached: OpenAI | undefined;

export function getOpenAI(): OpenAI {
  if (cached) return cached;
  // 40s request timeout + maxRetries=0 (NO retries). This caps a single OpenAI
  // call at 40s and guarantees no SDK-level retry doubles that to 80-100s and
  // blows past our 60s Vercel maxDuration. Inngest already retries the whole
  // step on failure — letting the SDK retry too would compound delays. The
  // 20s headroom under 60s covers Supabase writes + the Groq summarize call
  // that run after the OpenAI response in the analyze step.
  cached = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    timeout: 40_000,
    maxRetries: 0,
  });
  return cached;
}

// Default analyzer model; override via env. See openai-pricing.ts for the
// pricing table that must contain whatever model the env points at.
export const ANALYZER_MODEL: string = process.env.ANALYZER_MODEL || 'gpt-5.5-pro';

// TODO(v1.1): consider enabling OpenAI native web-search tool for fresher
// news context. Adds cost — measure signal-quality lift first.
