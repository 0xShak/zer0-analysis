import Groq from 'groq-sdk';
import { env } from './env';

let cached: Groq | undefined;

export function getGroq(): Groq {
  if (cached) return cached;
  cached = new Groq({ apiKey: env.GROQ_API_KEY });
  return cached;
}

// Models referenced by zer0.md.
export const GROQ_MODELS = {
  CHAT: 'llama-3.3-70b-versatile',
  CLASSIFIER: 'llama-3.1-8b-instant',
} as const;
