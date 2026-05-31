// Verdict-shaped sibling of deep-analyzer.ts. Where analyzeCandidate decides a
// TRADE (side/size/token), analyzeForReply produces a public READ for an X
// mention: an independent probability estimate vs the market price → a
// fair/over/under verdict + a tweet-shaped take. Reuses the same OpenAI client
// and the superforecaster system prompt; runs on MENTION_ANALYSIS_MODEL
// (cheaper than the brain's ANALYZER_MODEL) and ingests web research context.

import { getOpenAI } from '../openai/client';
import { env } from '../env';
import { SUPERFORECASTER_SYSTEM_PROMPT } from '../prompts/superforecaster';
import {
  REPLY_VERDICT_JSON_SCHEMA,
  validateReplyVerdict,
  type ReplyVerdict,
} from './validators';
import { computeCost } from '../cost/openai-pricing';

export type ReplyAnalyzeInput = {
  question: string;
  description?: string;
  resolutionSource?: string;
  category?: string;
  outcomes: string[];
  current_prices: number[]; // YES first; current_prices[0] anchors market_price
  liquidity_usd: number;
  volume_24h_usd: number;
  end_date: string;
  hours_to_resolution: number;
  researchContext: string; // formatResearchForPrompt output; '' when none
};

export type ReplyAnalyzeResult = {
  verdict: ReplyVerdict | null;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cached_tokens: number;
  cost_usd: number;
};

// Appended to the (static, cache-friendly) superforecaster base so it produces
// a verdict instead of a trade. The base prompt supplies the reasoning method;
// this redirects the OUTPUT to a public read.
const REPLY_ADDENDUM = `
---
TASK OVERRIDE: You are NOT sizing a trade here. Someone mentioned you on X asking about this market. Give your independent READ.
- Estimate the true probability of YES (my_estimate, 0..1) from base rates, the inside/outside view, and the RESEARCH CONTEXT (recent news) in the user message. Weight fresh evidence but don't overreact to one headline.
- Compare to the market's live YES price. Within ~10 percentage points = the market is FAIR. Market price well ABOVE your estimate = OVER (overpricing YES). Well BELOW = UNDER (underpricing YES).
- "take": a punchy, tweet-shaped read under ~240 chars, in your voice, that states your estimate vs the market and the verdict. A light trade angle is fine ("room to fade/reverse/scalp") but never call it financial advice. No hashtags, emojis, @mentions, links, or surrounding quotes.
Output ONLY the JSON object the user message specifies.`;

const REPLY_SYSTEM = SUPERFORECASTER_SYSTEM_PROMPT + REPLY_ADDENDUM;

export async function analyzeForReply(input: ReplyAnalyzeInput): Promise<ReplyAnalyzeResult> {
  const model = env.MENTION_ANALYSIS_MODEL;
  const openai = getOpenAI();

  const userPayload = {
    question: input.question,
    description: input.description,
    resolutionSource: input.resolutionSource,
    category: input.category,
    outcomes: input.outcomes,
    current_prices: input.current_prices,
    liquidity_usd: input.liquidity_usd,
    volume_24h_usd: input.volume_24h_usd,
    end_date: input.end_date,
    hours_to_resolution: input.hours_to_resolution,
  };
  const researchBlock = input.researchContext
    ? `\n\nRESEARCH CONTEXT (recent web/news):\n${input.researchContext}`
    : '\n\nRESEARCH CONTEXT: none available — reason from base rates and your own knowledge.';
  const userMessage =
    `${JSON.stringify(userPayload)}${researchBlock}\n\n` +
    `Return ONLY a JSON object matching: {"my_estimate":0..1, "market_price":0..1, "gap_pp":number, "verdict":"FAIR"|"OVER"|"UNDER", "confidence":0..1, "take":string}.`;

  const resp = await openai.chat.completions.create({
    model,
    max_completion_tokens: 1200,
    messages: [
      { role: 'system', content: REPLY_SYSTEM },
      { role: 'user', content: userMessage },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'ReplyVerdict',
        schema: REPLY_VERDICT_JSON_SCHEMA as Record<string, unknown>,
        strict: true,
      },
    },
  });

  const content = resp.choices[0]?.message?.content ?? '';
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  // Anchor market_price to the REAL live YES price rather than trusting the
  // model to echo it — the verdict/gap are derived from this in the validator.
  const realYes = input.current_prices[0];
  if (parsed && typeof realYes === 'number' && Number.isFinite(realYes)) {
    parsed.market_price = realYes;
  }

  const validation = parsed === null ? null : validateReplyVerdict(parsed);
  const verdict = validation && validation.ok ? validation.value : null;

  const usage = resp.usage;
  const tokens_in = usage?.prompt_tokens ?? 0;
  const tokens_out = usage?.completion_tokens ?? 0;
  const cached_tokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cost_usd = computeCost(model, { tokens_in, tokens_out, cached_tokens });

  return { verdict, model, tokens_in, tokens_out, cached_tokens, cost_usd };
}
