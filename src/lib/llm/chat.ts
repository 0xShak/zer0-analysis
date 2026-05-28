// Groq-primary chat completion with a cheap paid overflow fallback.
//
// Groq's free tier is the binding constraint: ~6,000 tokens/min, and the paid
// Developer tier is not purchasable, so the ceiling is fixed. Under a burst we
// get 429s. This wrapper keeps Groq PRIMARY (≈$0 for nearly all traffic) and
// only spills to a cheap 8B-class paid model on a transient Groq failure (429,
// 5xx, timeout). Steady-state cost stays ~$0; we pay only for burst overflow.
//
// Both groq-sdk and openai are OpenAI-shaped, so the request body is shared and
// the wrapper is model-agnostic. Both clients run maxRetries:0 by design (see
// groq.ts / openai/client.ts) — the wrapper owns the fallback, not the SDK.
// See 429_op.md.

import OpenAI from 'openai';
import type Groq from 'groq-sdk';
import { getGroq, GROQ_MODELS } from '../groq';
import { getOpenAI } from '../openai/client';
import { logUsage } from '../cost/log';
import { computeCost } from '../cost/openai-pricing';

// Cheap overflow model, configurable so it's tunable without a deploy (mirrors
// ANALYZER_MODEL in openai/client.ts). MUST stay 8B-class — do NOT point this
// at gpt-5.5-pro / GPT-4 / Opus. Its pricing row lives in openai-pricing.ts.
export const CHAT_FALLBACK_MODEL: string =
  process.env.CHAT_FALLBACK_MODEL || 'gpt-4o-mini';

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };

export type ChatCompletionParams = {
  messages: ChatMessage[];
  // Primary Groq model. Defaults to GROQ_MODELS.CHAT.
  groqModel?: string;
  // Overflow model. Defaults to CHAT_FALLBACK_MODEL.
  fallbackModel?: string;
  temperature?: number;
  maxTokens?: number;
  // Constrain output to a JSON object (used by the intent parser).
  jsonMode?: boolean;
  // Telemetry label for logUsage (e.g. 'chat', 'classify').
  step: string;
  // Injectable clients for tests.
  groq?: Groq;
  openai?: OpenAI;
};

export type ChatCompletionResult = {
  content: string;
  provider: 'groq' | 'openai';
  model: string;
  finishReason: string | null;
  usedFallback: boolean;
};

// Transient = worth spilling to the fallback. A 429 is the headline case; 5xx
// and network timeouts are also retry-on-other-provider. A 4xx (bad request)
// is our bug and would fail identically on the fallback, so we rethrow it.
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  // groq-sdk surfaces timeouts / dropped connections with no numeric status.
  const name = (err as { name?: string } | null)?.name ?? '';
  return /timeout|connection/i.test(name);
}

type UsageBearing = {
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};

// Fire-and-forget so accounting never adds latency to or throws into the reply
// path. createAdminClient() can throw synchronously when env is unset (e.g. in
// unit tests) — the .catch keeps that from surfacing as an unhandled rejection.
function recordUsage(
  provider: 'groq' | 'openai',
  model: string,
  resp: UsageBearing,
  step: string,
): void {
  const tokens_in = resp.usage?.prompt_tokens ?? 0;
  const tokens_out = resp.usage?.completion_tokens ?? 0;
  void logUsage({
    provider,
    model,
    tokens_in,
    tokens_out,
    cost_usd: computeCost(model, { tokens_in, tokens_out }),
    step,
  }).catch(() => {});
}

export async function chatCompletion(
  params: ChatCompletionParams,
): Promise<ChatCompletionResult> {
  const groqModel = params.groqModel ?? GROQ_MODELS.CHAT;
  const fallbackModel = params.fallbackModel ?? CHAT_FALLBACK_MODEL;
  const body = {
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    ...(params.jsonMode
      ? { response_format: { type: 'json_object' as const } }
      : {}),
  };

  const groq = params.groq ?? getGroq();
  const startedAt = Date.now();
  try {
    const resp = await groq.chat.completions.create({
      model: groqModel,
      messages: params.messages,
      ...body,
    });
    recordUsage('groq', groqModel, resp, params.step);
    console.info('[llm] groq ok', {
      step: params.step,
      model: groqModel,
      latencyMs: Date.now() - startedAt,
      finishReason: resp.choices[0]?.finish_reason ?? null,
    });
    return {
      content: resp.choices[0]?.message?.content ?? '',
      provider: 'groq',
      model: groqModel,
      finishReason: resp.choices[0]?.finish_reason ?? null,
      usedFallback: false,
    };
  } catch (err) {
    if (!isTransient(err)) throw err;
    console.warn('[llm] groq transient failure, spilling to fallback', {
      step: params.step,
      groqModel,
      fallbackModel,
      errorName: (err as { name?: string } | null)?.name,
      errorStatus: (err as { status?: number } | null)?.status,
      latencyMs: Date.now() - startedAt,
    });
  }

  // Overflow path: cheap paid model, same OpenAI-shaped request. If this also
  // throws, it propagates — the caller decides the last-resort behavior.
  const openai = params.openai ?? getOpenAI();
  const fbStartedAt = Date.now();
  const resp = await openai.chat.completions.create({
    model: fallbackModel,
    messages: params.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    ...body,
  });
  recordUsage('openai', fallbackModel, resp, params.step);
  console.info('[llm] fallback served', {
    step: params.step,
    model: fallbackModel,
    latencyMs: Date.now() - fbStartedAt,
    finishReason: resp.choices[0]?.finish_reason ?? null,
  });
  return {
    content: resp.choices[0]?.message?.content ?? '',
    provider: 'openai',
    model: fallbackModel,
    finishReason: resp.choices[0]?.finish_reason ?? null,
    usedFallback: true,
  };
}
