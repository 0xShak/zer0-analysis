-- LLM call accounting for the daily-budget guard and post-hoc cost analysis.
-- Service-role only; RLS enabled with no policies = no anon/authenticated read.

create table public.agent_usage (
  id bigserial primary key,
  provider text not null,           -- 'openai' | 'groq'
  model text not null,
  tokens_in int not null,
  tokens_out int not null,
  cached_tokens int default 0,      -- OpenAI: usage.prompt_tokens_details.cached_tokens
  cost_usd numeric(10,6) not null,
  step text,                        -- 'deep-analyze' | 'classify' | 'summarize' | 'chat-respond'
  brain_tick_id text,
  created_at timestamptz default now()
);
create index on public.agent_usage (created_at desc);
create index on public.agent_usage (provider, created_at desc);

alter table public.agent_usage enable row level security;
-- No policies — only the service role bypasses RLS, so this table is
-- effectively service-role-only for both reads and writes.
