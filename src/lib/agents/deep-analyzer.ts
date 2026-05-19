import { getOpenAI, ANALYZER_MODEL } from '../openai/client';
import { SUPERFORECASTER_SYSTEM_PROMPT } from '../prompts/superforecaster';
import {
  ANALYSIS_JSON_SCHEMA,
  validateAnalysisOutput,
  type AnalysisCandidate,
  type ValidationResult,
} from './validators';
import { computeCost } from '../cost/openai-pricing';

export type DeepAnalyzeInput = {
  conditionId: string;
  question: string;
  description?: string;
  resolutionSource?: string;
  category?: string;
  outcomes: string[];
  current_prices: number[];
  liquidity_usd: number;
  volume_24h_usd: number;
  end_date: string;
  hours_to_resolution: number;
  token_ids: string[];
};

export type DeepAnalyzeResult = {
  validation: ValidationResult;
  rawJson: unknown;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cached_tokens: number;
  cost_usd: number;
};

export async function analyzeCandidate(candidate: DeepAnalyzeInput): Promise<DeepAnalyzeResult> {
  const openai = getOpenAI();

  // User message: serialised candidate + explicit output instruction.
  const userPayload = {
    question: candidate.question,
    description: candidate.description,
    resolutionSource: candidate.resolutionSource,
    category: candidate.category,
    outcomes: candidate.outcomes,
    current_prices: candidate.current_prices,
    liquidity_usd: candidate.liquidity_usd,
    volume_24h_usd: candidate.volume_24h_usd,
    end_date: candidate.end_date,
    hours_to_resolution: candidate.hours_to_resolution,
    token_ids: candidate.token_ids,
  };
  const userMessage = `${JSON.stringify(userPayload)}\n\nReturn ONLY a JSON object matching: {"conviction":0..1, "side":"BUY"|"SELL"|"NONE", "token_id":string, "suggested_price":0.05..0.95, "suggested_size_usd":1..100, "rationale":100..1000 chars string}.`;

  // gpt-5.5-pro is a reasoning model: `max_tokens` is rejected (must use
  // `max_completion_tokens`) and only the default temperature is supported,
  // so we omit `temperature` entirely. `reasoning_tokens` from the response
  // are already rolled into `usage.completion_tokens` for billing purposes
  // (see OpenAI SDK CompletionTokensDetails docs).
  const resp = await openai.chat.completions.create({
    model: ANALYZER_MODEL,
    max_completion_tokens: 1500,
    messages: [
      // System prompt is first AND identical across calls so the prefix
      // qualifies for OpenAI prompt caching (≥1024 tokens). Note: gpt-5.5-pro
      // does NOT cache — see openai-pricing.ts.
      { role: 'system', content: SUPERFORECASTER_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'AnalysisOutput',
        schema: ANALYSIS_JSON_SCHEMA as Record<string, unknown>,
        strict: true,
      },
    },
  });

  const content = resp.choices[0]?.message?.content ?? '';
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }

  const candidateForValidation: AnalysisCandidate = {
    conditionId: candidate.conditionId,
    question: candidate.question,
    tokenIds: candidate.token_ids,
  };
  const validation: ValidationResult =
    parsed === null
      ? { ok: false, reason: 'JSON parse failed' }
      : validateAnalysisOutput(parsed, candidateForValidation);

  const usage = resp.usage;
  const tokens_in = usage?.prompt_tokens ?? 0;
  const tokens_out = usage?.completion_tokens ?? 0;
  const cached_tokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cost_usd = computeCost(ANALYZER_MODEL, { tokens_in, tokens_out, cached_tokens });

  return {
    validation,
    rawJson: parsed,
    model: ANALYZER_MODEL,
    tokens_in,
    tokens_out,
    cached_tokens,
    cost_usd,
  };
}
