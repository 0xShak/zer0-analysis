import OpenAI from 'openai';
import { env } from '../env';

let cached: OpenAI | undefined;

export function getOpenAI(): OpenAI {
  if (cached) return cached;
  // No baseURL override per spec — pinned to api.openai.com.
  cached = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return cached;
}

// Default analyzer model; override via env. See openai-pricing.ts for the
// pricing table that must contain whatever model the env points at.
export const ANALYZER_MODEL: string = process.env.ANALYZER_MODEL || 'gpt-5.5-pro';

// TODO(v1.1): consider enabling OpenAI native web-search tool for fresher
// news context. Adds cost — measure signal-quality lift first.
