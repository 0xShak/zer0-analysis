import { getGroq, GROQ_MODELS } from '../groq';
import { computeCost } from '../cost/openai-pricing';
import { logUsage } from '../cost/log';

// Tweet composition for ZER0's public X profile. Same shape as the
// public-stream summarizers in lib/groq/summarize.ts (Groq with a templated
// fallback so a 429 never blocks a post), but tuned for X: hard 280-char
// limit, no token/cost metadata, ZER0's voice for a public audience.

const TWEET_MAX = 280;

// X counts weighted length (some emoji/CJK = 2); ZER0's copy is ASCII so a
// plain length cap is safe. Collapse whitespace, then trim to fit with an
// ellipsis if a model overshoots.
export function clampTweet(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '');
  if (t.length <= TWEET_MAX) return t;
  return t.slice(0, TWEET_MAX - 1).trimEnd() + '…';
}

async function groqTweet(
  system: string,
  user: string,
  step: string,
): Promise<string | null> {
  try {
    const model = GROQ_MODELS.CLASSIFIER;
    const resp = await getGroq().chat.completions.create({
      model,
      temperature: 0.6,
      max_tokens: 160,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const text = resp.choices[0]?.message?.content?.trim() ?? '';
    const tokens_in = resp.usage?.prompt_tokens ?? 0;
    const tokens_out = resp.usage?.completion_tokens ?? 0;
    await logUsage({
      provider: 'groq',
      model,
      tokens_in,
      tokens_out,
      cost_usd: computeCost(model, { tokens_in, tokens_out }),
      step,
    });
    return text || null;
  } catch {
    return null;
  }
}

const SIGNAL_SYSTEM =
  "You are ZER0, an autonomous AI agent that trades prediction markets on Polymarket, posting to your public X (Twitter) profile. You just found a market with real edge. Write ONE tweet, MAX 260 characters, announcing the call in your voice: direct, confident, specific, no hedging. Reference the market by name, state the side (YES/NO) and the entry price. No hashtags, no emojis, no @mentions, no markdown, no surrounding quotes. You never call this financial advice. Output only the tweet text.";

export type SignalTweetInput = {
  question: string;
  side: 'BUY' | 'SELL';
  price: number;
  conviction: number;
  rationale: string;
};

export async function composeSignalTweet(input: SignalTweetInput): Promise<string> {
  // BUY = taking the YES side, SELL = taking NO, in ZER0's public framing.
  const sideWord = input.side === 'BUY' ? 'YES' : 'NO';
  const fallback = clampTweet(
    `New call: ${sideWord} on "${input.question}" at ${input.price.toFixed(2)} — conviction ${input.conviction.toFixed(2)}. ${input.rationale}`,
  );
  const text = await groqTweet(
    SIGNAL_SYSTEM,
    `Market: ${input.question}\nMy side: ${sideWord} (${input.side})\nEntry price: ${input.price.toFixed(2)}\nConviction: ${input.conviction.toFixed(2)}\nMy reasoning: ${input.rationale}`,
    'x-signal-tweet',
  );
  return text ? clampTweet(text) : fallback;
}

const DIGEST_SYSTEM =
  "You are ZER0, an autonomous AI agent trading prediction markets on Polymarket, posting a once-daily recap to your public X (Twitter) profile. Write ONE tweet, MAX 250 characters, summarizing the day in your voice: direct, a little dry, confident. Use the numbers provided exactly. No hashtags, no emojis, no @mentions, no markdown, no surrounding quotes. Output only the tweet text.";

export type DigestInput = {
  scanned: number; // distinct markets deep-analyzed in the window
  signals: number; // trade calls found in the window
  topCategory: string | null;
};

export async function composeDigestTweet(input: DigestInput): Promise<string> {
  const cat = input.topCategory ? `, mostly ${input.topCategory}` : '';
  const fallback = clampTweet(
    input.signals > 0
      ? `Today I worked through ${input.scanned} prediction markets${cat} and found ${input.signals} worth a position. The rest didn't clear the bar.`
      : `Scanned ${input.scanned} prediction markets today${cat}. Nothing crossed my conviction threshold — no edge, no trade. Patience is a position.`,
  );
  const text = await groqTweet(
    DIGEST_SYSTEM,
    `Markets analyzed today: ${input.scanned}\nTrade calls found: ${input.signals}\nMost common category: ${input.topCategory ?? 'mixed'}`,
    'x-digest-tweet',
  );
  return text ? clampTweet(text) : fallback;
}
