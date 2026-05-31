// Output validation for the deep-analyzer step. Any rejection here must
// cause the caller to skip insertion AND emit a `scope='app'` thought
// describing the reject reason (spec §4).

// Note: the success shape narrows `side` to BUY|SELL because
// validateAnalysisOutput rejects NONE explicitly. The raw model output may
// still be NONE — that's handled by the validator before this type is used.
export type AnalysisOutput = {
  conviction: number;
  side: 'BUY' | 'SELL';
  token_id: string;
  suggested_price: number;
  suggested_size_usd: number;
  rationale: string;
};

export type AnalysisCandidate = {
  conditionId: string;
  question: string;
  tokenIds: string[];
};

export type ValidationResult =
  | { ok: true; value: AnalysisOutput }
  | { ok: false; reason: string };

export function validateAnalysisOutput(
  raw: unknown,
  candidate: AnalysisCandidate,
): ValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'not an object' };
  }
  const obj = raw as Record<string, unknown>;

  const conviction = obj.conviction;
  const side = obj.side;
  const tokenId = obj.token_id;
  const price = obj.suggested_price;
  const size = obj.suggested_size_usd;
  const rationale = obj.rationale;

  if (typeof conviction !== 'number' || conviction < 0 || conviction > 1) {
    return { ok: false, reason: 'conviction not in [0,1]' };
  }
  if (side !== 'BUY' && side !== 'SELL' && side !== 'NONE') {
    return { ok: false, reason: `invalid side: ${String(side)}` };
  }
  if (side === 'NONE') {
    return { ok: false, reason: 'side=NONE — no trade flagged' };
  }
  if (conviction > 0.95) {
    return { ok: false, reason: 'conviction > 0.95 (overconfidence guard)' };
  }
  if (typeof price !== 'number' || price < 0.05 || price > 0.95) {
    return { ok: false, reason: 'suggested_price outside [0.05, 0.95]' };
  }
  if (typeof size !== 'number' || size < 1 || size > 100) {
    return { ok: false, reason: 'suggested_size_usd outside [1, 100]' };
  }
  if (typeof rationale !== 'string' || rationale.length < 100 || rationale.length > 1000) {
    return { ok: false, reason: `rationale length ${typeof rationale === 'string' ? rationale.length : 'n/a'} outside [100, 1000]` };
  }
  if (typeof tokenId !== 'string' || !candidate.tokenIds.includes(tokenId)) {
    return { ok: false, reason: 'token_id not in candidate token_ids' };
  }

  // side has been narrowed: NONE was rejected above.
  return {
    ok: true,
    value: {
      conviction,
      side: side as 'BUY' | 'SELL',
      token_id: tokenId,
      suggested_price: price,
      suggested_size_usd: size,
      rationale,
    },
  };
}

// ─── Opinionated mention-reply verdict (lib/agents/reply-analyzer.ts) ────────
// Verdict-shaped sibling of AnalysisOutput. Unlike the trade path, a "fairly
// priced" read is a VALID, common outcome (FAIR) — not a rejection — and there
// is no token_id / position sizing. Used by the X mention opinion reply.

export type ReplyVerdict = {
  my_estimate: number; // ZER0's probability for YES, [0,1]
  market_price: number; // live YES price, [0,1]
  gap_pp: number; // (my_estimate - market_price) in percentage points
  verdict: 'FAIR' | 'OVER' | 'UNDER'; // OVER = market overpricing YES; UNDER = underpricing
  confidence: number; // [0,1]
  take: string; // tweet-shaped read
};

export type ReplyVerdictResult =
  | { ok: true; value: ReplyVerdict }
  | { ok: false; reason: string };

// Edge threshold (percentage points) below which we call the market FAIR —
// mirrors the brain's >10pp mispricing bar in the superforecaster prompt.
const FAIR_BAND_PP = 10;

export function validateReplyVerdict(raw: unknown): ReplyVerdictResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'not an object' };
  }
  const obj = raw as Record<string, unknown>;
  const myEstimate = obj.my_estimate;
  const marketPrice = obj.market_price;
  const confidence = obj.confidence;
  const take = obj.take;

  if (typeof myEstimate !== 'number' || myEstimate < 0 || myEstimate > 1) {
    return { ok: false, reason: 'my_estimate not in [0,1]' };
  }
  if (typeof marketPrice !== 'number' || marketPrice < 0 || marketPrice > 1) {
    return { ok: false, reason: 'market_price not in [0,1]' };
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    return { ok: false, reason: 'confidence not in [0,1]' };
  }
  if (typeof take !== 'string' || take.trim().length < 20) {
    return { ok: false, reason: 'take too short' };
  }

  // Derive the gap and verdict ourselves so they're internally consistent even
  // if the model's own verdict/gap fields are sloppy. Positive gap = ZER0's
  // estimate above the market = market UNDERpricing YES.
  const gap_pp = Math.round((myEstimate - marketPrice) * 100);
  const verdict: ReplyVerdict['verdict'] =
    Math.abs(gap_pp) < FAIR_BAND_PP ? 'FAIR' : gap_pp > 0 ? 'UNDER' : 'OVER';

  return {
    ok: true,
    value: { my_estimate: myEstimate, market_price: marketPrice, gap_pp, verdict, confidence, take },
  };
}

// Strict JSON schema for the reply verdict (OpenAI structured outputs). `gap_pp`
// and `verdict` are requested from the model but recomputed in validateReplyVerdict.
export const REPLY_VERDICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['my_estimate', 'market_price', 'gap_pp', 'verdict', 'confidence', 'take'],
  properties: {
    my_estimate: { type: 'number', minimum: 0, maximum: 1 },
    market_price: { type: 'number', minimum: 0, maximum: 1 },
    gap_pp: { type: 'number' },
    verdict: { type: 'string', enum: ['FAIR', 'OVER', 'UNDER'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    take: { type: 'string', minLength: 20, maxLength: 500 },
  },
} as const;

// JSON Schema mirroring the AnalysisOutput shape. Used for OpenAI
// structured outputs (response_format: json_schema).
export const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['conviction', 'side', 'token_id', 'suggested_price', 'suggested_size_usd', 'rationale'],
  properties: {
    conviction: { type: 'number', minimum: 0, maximum: 1 },
    side: { type: 'string', enum: ['BUY', 'SELL', 'NONE'] },
    token_id: { type: 'string' },
    suggested_price: { type: 'number', minimum: 0.05, maximum: 0.95 },
    suggested_size_usd: { type: 'number', minimum: 1, maximum: 100 },
    rationale: { type: 'string', minLength: 100, maxLength: 1000 },
  },
} as const;
