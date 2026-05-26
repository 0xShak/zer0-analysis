import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { loadPersona } from './persona';

export type ChatHistoryRow = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type OpenTrade = {
  market_question: string | null;
  side: 'BUY' | 'SELL';
  price: number;
  conviction: number;
  rationale: string;
};

export type RecentMarket = {
  condition_id: string;
  question: string | null;
  yes_price: number | null;
  category: string | null;
  deterministic: boolean | null;
  classifier_confidence: number | null;
  last_analyzed_at: string | null;
  last_seen_at: string | null;
};

export type RecentThought = {
  content: string;
  market_condition_id: string | null;
  created_at: string;
};

export type ChatContext = {
  messages: ChatHistoryRow[];
  trades: OpenTrade[];
  recentMarkets: RecentMarket[];
  recentThoughts: RecentThought[];
  persona: string;
};

// Context pieces fetched in parallel per prompt1 §5, extended with recent
// classified-deterministic markets + recent public thoughts so the bot has
// real grounding to reference instead of hallucinating Polymarket markets.
//  - history: last HISTORY_LIMIT messages tied to either user_id or session_id.
//  - trades: up to 10 still-open recommendations.
//  - recentMarkets: last 24h of deterministic markets ZER0 has at least
//    classified (top RECENT_MARKETS_LIMIT) — includes both deep-analyzed AND
//    classified-but-not-yet-deep-analyzed ones, so the chat can talk about
//    crypto/policy/election markets ZER0 has seen even before the brain
//    forms a deep view. last_analyzed_yes_price may be NULL for the latter.
//  - recentThoughts: last 10 public thoughts in 24h — continuity across
//    conversations.
//  - persona: cached ZER0.md content.
export async function loadChatContext(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  userId: string | null,
): Promise<ChatContext> {
  // History depth feeds straight into the prompt and counts against Groq's
  // free-tier per-minute token ceiling (~6k TPM, shared across all models).
  // 10 turns is enough for conversational continuity while keeping each chat
  // call small enough that a couple of messages can land within the same
  // minute without 429ing. Was 20 — see groq.ts for the full rate-limit note.
  const HISTORY_LIMIT = 10;

  const historyQuery = userId
    ? supabase
        .from('messages')
        .select('role, content, created_at')
        .or(`user_id.eq.${userId},session_id.eq.${sessionId}`)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT)
    : supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT);

  const nowIso = new Date().toISOString();
  const since24hIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // How many recently-seen deterministic markets the chat may reference. This
  // is the real ceiling on chat breadth — brain-tick's classify step feeds
  // market_scans, but the model only ever sees this many. Trimmed from 40 to
  // 15: the market list is the largest variable chunk of the system prompt,
  // and on Groq's free tier (~6k tokens/min, shared across models) a 40-market
  // prompt could consume most of the per-minute budget in a single call,
  // 429ing the next message. 15 keeps grounding broad while leaving room for
  // back-to-back messages. See groq.ts for the full rate-limit rationale.
  const RECENT_MARKETS_LIMIT = 15;

  const [historyRes, tradesRes, recentMarketsRes, recentThoughtsRes, persona] =
    await Promise.all([
      historyQuery,
      supabase
        .from('trade_recommendations')
        .select('market_question, side, price, conviction, rationale, expires_at')
        .eq('status', 'open')
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('market_scans')
        .select(
          'condition_id, question, last_analyzed_yes_price, category, deterministic, classifier_confidence, last_analyzed_at, last_seen_at',
        )
        .eq('deterministic', true)
        .gte('last_seen_at', since24hIso)
        .order('last_seen_at', { ascending: false })
        .limit(RECENT_MARKETS_LIMIT),
      supabase
        .from('thoughts')
        .select('content, market_condition_id, created_at')
        .eq('scope', 'public')
        .gte('created_at', since24hIso)
        .order('created_at', { ascending: false })
        .limit(10),
      loadPersona(),
    ]);

  const messages: ChatHistoryRow[] = (historyRes.data ?? [])
    .slice()
    .reverse()
    .map((m) => ({
      role: m.role as ChatHistoryRow['role'],
      content: m.content,
    }));

  const trades: OpenTrade[] = (tradesRes.data ?? []).map((t) => ({
    market_question: t.market_question,
    side: t.side as 'BUY' | 'SELL',
    price: Number(t.price),
    conviction: Number(t.conviction),
    rationale: t.rationale,
  }));

  const recentMarkets: RecentMarket[] = (recentMarketsRes.data ?? []).map(
    (r) => ({
      condition_id: r.condition_id,
      question: r.question,
      yes_price:
        r.last_analyzed_yes_price !== null
          ? Number(r.last_analyzed_yes_price)
          : null,
      category: r.category,
      deterministic: r.deterministic,
      classifier_confidence:
        r.classifier_confidence !== null
          ? Number(r.classifier_confidence)
          : null,
      last_analyzed_at: r.last_analyzed_at,
      last_seen_at: r.last_seen_at,
    }),
  );

  const recentThoughts: RecentThought[] = (recentThoughtsRes.data ?? []).map(
    (t) => ({
      content: t.content,
      market_condition_id: t.market_condition_id,
      created_at: t.created_at,
    }),
  );

  return { messages, trades, recentMarkets, recentThoughts, persona };
}

// Render the trade list for inclusion in the system prompt — short, scannable,
// rationale truncated to the first sentence so the system prompt doesn't
// balloon past a few hundred tokens.
export function formatTradesForSystem(trades: OpenTrade[]): string {
  if (trades.length === 0) return '(no open recommendations right now)';
  return trades
    .map((t) => {
      const headline = (t.rationale ?? '').split(/(?<=[.!?])\s+/)[0]?.trim() ?? '';
      const question = t.market_question ?? '(unknown market)';
      return `- ${question} — ${t.side} @ ${t.price.toFixed(2)} (conviction ${t.conviction.toFixed(2)}): ${headline}`;
    })
    .join('\n');
}

// "X ago" — coarse, single-unit; we don't need minute-precision in a prompt.
function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'unknown time ago';
  const diffMs = now - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Block injected into the system prompt as "## What you've been doing".
// Deliberately uses authoritative phrasing — these are the markets ZER0 has
// actually analyzed in the last 24h. If the lists are empty we say so
// explicitly so the model can tell the user instead of inventing.
export function formatRecentWorkForSystem(
  markets: RecentMarket[],
  thoughts: RecentThought[],
): string {
  const now = Date.now();
  const marketsBlock =
    markets.length === 0
      ? '(no deterministic markets seen in the last 24h)'
      : markets
          .map((m) => {
            const q = m.question ?? '(unknown question)';
            const cat = m.category ?? 'uncategorised';
            const price =
              m.yes_price !== null ? m.yes_price.toFixed(3) : 'unknown';
            // Deep-analyzed rows have last_analyzed_at; classified-only rows
            // fall back to last_seen_at. Verb shifts to match: "analyzed"
            // vs "seen".
            const verb = m.last_analyzed_at ? 'analyzed' : 'seen';
            const ts = m.last_analyzed_at ?? m.last_seen_at;
            return `- "${q}" (${cat}) — Yes priced at ${price}, ${verb} ${relativeTime(ts, now)}`;
          })
          .join('\n');

  const thoughtsBlock =
    thoughts.length === 0
      ? '(no public thoughts in the last 24h)'
      : thoughts.map((t) => `- ${t.content}`).join('\n');

  return `Markets analyzed in the last 24h (authoritative — only reference these):
${marketsBlock}

Recent public thoughts you've emitted:
${thoughtsBlock}`;
}

// Anti-hallucination instructions, appended to the bottom of the system
// prompt.
export const CHAT_GROUND_RULES = `## Ground rules for honesty

- You may reference any market that appears in the 'What you've been doing' OR 'Live Polymarket data' sections above. If a user asks about a market that appears in NEITHER, say you don't have it in front of you rather than inventing one.
- The 'Live Polymarket data' section, when present, was just fetched live from Polymarket for this exact question. Treat its prices, volumes, and resolution dates as authoritative and answer directly from it — this is the real, current market. Don't hedge with "I haven't seen it" when it's right there.
- The 'What you've been doing' list mixes markets you've deep-analyzed ('analyzed Xh ago') with ones you've only classified-and-watched ('seen Xh ago'). Be honest about the difference: for 'analyzed' markets you have a real view; for 'seen' markets you can name them and say you classified them as deterministic, but don't pretend to have a deep conviction call.
- Never invent specific prices, dates, or question text. If you don't have the exact data, say so. When a Yes price shows 'unknown', say so rather than guessing.
- Specific dates and prices in the context above are authoritative. Don't round or paraphrase them in ways that change meaning.
- If you have zero markets to reference in either section, tell the user you don't have that market in front of you right now rather than fabricating examples.`;
