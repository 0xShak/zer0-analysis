// Output validation for the deep-analyzer step. Any rejection here must
// cause the caller to skip insertion AND emit a `scope='app'` thought
// describing the reject reason (spec §4).

import { stripLinksAndHandles } from '../text-safety';

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
  if (typeof rationale !== 'string') {
    return { ok: false, reason: 'rationale not a string' };
  }
  // Strip injected links/@handles BEFORE the length gate so a rationale that is
  // mostly an attacker payload fails the quality bar instead of shipping cleaned
  // but empty (audit2.md M-A).
  const cleanRationale = stripLinksAndHandles(rationale);
  if (cleanRationale.length < 100 || cleanRationale.length > 1000) {
    return { ok: false, reason: `rationale length ${cleanRationale.length} outside [100, 1000]` };
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
      rationale: cleanRationale,
    },
  };
}

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
