import { createAdminClient } from '../supabase/admin';

const DEFAULT_DAILY_BUDGET_USD = 25;

function startOfUtcDay(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export async function isUnderDailyBudget(
  provider: 'openai' | 'groq' = 'openai',
): Promise<{ underBudget: boolean; spentUsd: number; budgetUsd: number }> {
  const budgetUsd = parseFloat(
    process.env.ANALYZER_DAILY_BUDGET_USD ?? String(DEFAULT_DAILY_BUDGET_USD),
  );
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('agent_usage')
    .select('cost_usd')
    .eq('provider', provider)
    .gte('created_at', startOfUtcDay());
  if (error) {
    // Fail open — don't block the brain on a transient query error.
    console.error('[budget] sum query failed', error);
    return { underBudget: true, spentUsd: 0, budgetUsd };
  }
  const spentUsd = (data ?? []).reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
  return { underBudget: spentUsd < budgetUsd, spentUsd, budgetUsd };
}
