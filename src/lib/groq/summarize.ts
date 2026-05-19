import { getGroq, GROQ_MODELS } from '../groq';
import { computeCost } from '../cost/openai-pricing';

export type SummaryResult = {
  text: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
};

// All public-stream summaries share the same Groq call shape — only the
// system prompt and the user payload differ. We bump temperature so the feed
// doesn't read like the same sentence reshuffled tick after tick.
async function runGroqSummary(systemPrompt: string, userContent: string): Promise<SummaryResult> {
  const groq = getGroq();
  const model = GROQ_MODELS.CLASSIFIER;
  const resp = await groq.chat.completions.create({
    model,
    temperature: 0.6,
    max_tokens: 180,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });
  const text = resp.choices[0]?.message?.content?.trim() ?? '';
  const usage = resp.usage;
  const tokens_in = usage?.prompt_tokens ?? 0;
  const tokens_out = usage?.completion_tokens ?? 0;
  return {
    text,
    model,
    tokens_in,
    tokens_out,
    cost_usd: computeCost(model, { tokens_in, tokens_out }),
  };
}

const SIGNAL_SYSTEM =
  "You are ZER0's voice on the public chain-of-thought stream. The agent just found a trade opportunity. Summarize in 1-2 sentences with confident, specific energy. Reference the market by name. No hedging. Output text only — no JSON, no markdown, no quotes around the answer.";

const SKIP_SYSTEM =
  "You are ZER0's voice on the public chain-of-thought stream. The agent just looked at a prediction market and decided not to trade it. Summarize in 1-2 sentences with calm, skeptical energy — frame as 'looked at this and...' or 'considered this but...', not 'rejected'. Reference the market by name. Acknowledge what's interesting before explaining why you're skipping. Output text only.";

const SCAN_SYSTEM =
  "You are ZER0's voice on a public chain-of-thought stream. The agent just finished a scan of Polymarket. Write 1-2 sentences summarizing the scan with personality — vary the phrasing so the feed doesn't feel repetitive. Mention specific category counts if interesting (e.g. 'mostly sports tonight', '8 election markets came up'). Acknowledge when it's a quiet scan vs a busy one. Output text only — no JSON, no markdown.";

export type TradeSignalInput = {
  question: string;
  rationale: string;
  side: 'BUY' | 'SELL';
  price: number;
  conviction: number;
};

export async function summarizeTradeSignal(input: TradeSignalInput): Promise<SummaryResult> {
  const userContent = `Market: ${input.question}
Decision: ${input.side} at price ${input.price.toFixed(2)}, conviction ${input.conviction.toFixed(2)}
Full reasoning from the analyst: ${input.rationale}`;
  return runGroqSummary(SIGNAL_SYSTEM, userContent);
}

export type SkipInput = {
  question: string;
  rationale: string;
  reason: string;
};

export async function summarizeSkip(input: SkipInput): Promise<SummaryResult> {
  const userContent = `Market: ${input.question}
Skip reason: ${input.reason}
Full reasoning from the analyst: ${input.rationale}`;
  return runGroqSummary(SKIP_SYSTEM, userContent);
}

export type ScanInput = {
  rawCount: number;
  pagesFetched: number;
  passingFilter: number;
  freshCount: number;
  seenCount: number;
  deterministicCount: number;
  byCategory: Record<string, number>;
};

export async function summarizeScan(input: ScanInput): Promise<SummaryResult> {
  const categories = Object.entries(input.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${cat}=${n}`)
    .join(', ');
  const userContent = `Scan stats:
- Raw markets fetched: ${input.rawCount} across ${input.pagesFetched} pages
- Passed numeric filter: ${input.passingFilter}
- Fresh (first time seen): ${input.freshCount}
- Already seen in prior ticks: ${input.seenCount}
- Classified as deterministic: ${input.deterministicCount}
- Category breakdown of classified: ${categories || 'none'}`;
  return runGroqSummary(SCAN_SYSTEM, userContent);
}
