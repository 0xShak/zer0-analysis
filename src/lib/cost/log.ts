import { createAdminClient } from '../supabase/admin';

export type LogUsageInput = {
  provider: 'openai' | 'groq' | 'tavily';
  model: string;
  tokens_in: number;
  tokens_out: number;
  cached_tokens?: number;
  cost_usd: number;
  step: 'deep-analyze' | 'classify' | 'summarize' | 'chat-respond' | string;
  brain_tick_id?: string;
};

export async function logUsage(input: LogUsageInput): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from('agent_usage').insert({
    provider: input.provider,
    model: input.model,
    tokens_in: input.tokens_in,
    tokens_out: input.tokens_out,
    cached_tokens: input.cached_tokens ?? 0,
    cost_usd: input.cost_usd,
    step: input.step,
    brain_tick_id: input.brain_tick_id ?? null,
  });
  if (error) {
    // Never throw from accounting — the caller is in the middle of doing
    // real work. Just leave a server log breadcrumb.
    console.error('[logUsage] insert failed', error);
  }
}
