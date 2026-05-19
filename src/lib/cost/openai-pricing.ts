// Verified 2026-05-19 against developers.openai.com/api/docs/models/gpt-5.5
// and .../gpt-5.5-pro.
//
// IMPORTANT: gpt-5.5-pro does NOT offer a cached input discount. The
// docs explicitly state "GPT-5.5 pro does not offer a cached input
// discount". We model that as cached_input_per_million=null and bill
// cached tokens at the full input rate.

export type PricingRow = {
  input_per_million: number;
  cached_input_per_million: number | null;
  output_per_million: number;
};

export const PRICING: Record<string, PricingRow> = {
  // gpt-5.5-pro: $30 / no cache / $180 (verified 2026-05-19).
  'gpt-5.5-pro': {
    input_per_million: 30,
    cached_input_per_million: null,
    output_per_million: 180,
  },
  'gpt-5.5-pro-2026-04-23': {
    input_per_million: 30,
    cached_input_per_million: null,
    output_per_million: 180,
  },
  // gpt-5.5 standard: $5 / $0.50 / $30 (verified 2026-05-19).
  'gpt-5.5': {
    input_per_million: 5,
    cached_input_per_million: 0.5,
    output_per_million: 30,
  },
  'gpt-5.5-2026-04-23': {
    input_per_million: 5,
    cached_input_per_million: 0.5,
    output_per_million: 30,
  },
  // Groq Llama 3.1 8B Instant: $0.05 in, $0.08 out (groq.com/pricing).
  'llama-3.1-8b-instant': {
    input_per_million: 0.05,
    cached_input_per_million: null,
    output_per_million: 0.08,
  },
  // Groq Llama 3.3 70B Versatile: $0.59 in, $0.79 out (groq.com/pricing).
  'llama-3.3-70b-versatile': {
    input_per_million: 0.59,
    cached_input_per_million: null,
    output_per_million: 0.79,
  },
};

export type UsageShape = {
  tokens_in: number;
  tokens_out: number;
  cached_tokens?: number;
};

// (tokens_in - cached) * input_rate + cached * cached_rate + tokens_out * output_rate
// If the model has no cached-rate entry, cached tokens bill at full input rate.
export function computeCost(model: string, usage: UsageShape): number {
  const row = PRICING[model];
  if (!row) {
    // Unknown model — return 0 so we don't crash on rollouts. Surface in
    // logs by writing a `scope='app'` thought from the caller.
    return 0;
  }
  const cached = usage.cached_tokens ?? 0;
  const billedInput = Math.max(0, usage.tokens_in - cached);
  const cachedRate = row.cached_input_per_million ?? row.input_per_million;
  const cost =
    (billedInput * row.input_per_million +
      cached * cachedRate +
      usage.tokens_out * row.output_per_million) /
    1_000_000;
  // Round to micro-dollars (6 decimals) to match the DB column precision.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
