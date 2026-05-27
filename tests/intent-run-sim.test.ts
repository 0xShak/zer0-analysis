// The run_sim intent is the structural switch that routes a "simulate X"
// message into the MiroShark flow instead of chat. Pin that the parser
// recognizes it and pulls out the scenario, with an injected fake Groq so no
// network is touched (parseIntent accepts a `groq` override for exactly this).

import { describe, it, expect } from 'vitest';
import { parseIntent } from '@/telegram-bot/intent/parse';
import { getGroq } from '@/lib/groq';

// Minimal Groq stand-in: returns whatever JSON we hand it as the completion.
function fakeGroq(json: unknown): ReturnType<typeof getGroq> {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(json) } }],
        }),
      },
    },
  } as unknown as ReturnType<typeof getGroq>;
}

describe('parseIntent run_sim', () => {
  it('classifies a simulate request and extracts the scenario', async () => {
    const intent = await parseIntent({
      userText: 'simulate what happens to BTC if the Fed cuts rates',
      groq: fakeGroq({
        intent: 'run_sim',
        market_query: null,
        scenario: 'what happens to BTC if the Fed cuts rates',
        side: null,
        size_kind: null,
        size_value: null,
        outcome: null,
        confidence: 0.9,
      }),
    });
    expect(intent.intent).toBe('run_sim');
    expect(intent.scenario).toBe('what happens to BTC if the Fed cuts rates');
    expect(intent.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('still parses non-sim intents with the new scenario field present', async () => {
    const intent = await parseIntent({
      userText: 'hey what are you watching',
      groq: fakeGroq({
        intent: 'small_talk',
        market_query: null,
        scenario: null,
        side: null,
        size_kind: null,
        size_value: null,
        outcome: null,
        confidence: 1,
      }),
    });
    expect(intent.intent).toBe('small_talk');
    expect(intent.scenario).toBeNull();
  });
});
