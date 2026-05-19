-- Day 4: cross-channel binding. A logged-in web session generates a single-use
-- code; the user pastes it into Telegram via `/link <code>` and the bot
-- transfers the matching user_id over so memory merges across channels.

create table public.link_codes (
  code text primary key,
  session_id uuid references public.sessions(id),
  user_id uuid references public.users(id),
  created_at timestamptz default now(),
  expires_at timestamptz default now() + interval '15 minutes',
  consumed_at timestamptz
);
create index on public.link_codes (expires_at) where consumed_at is null;

-- Service-role only — issuance and consumption both happen server-side.
alter table public.link_codes enable row level security;
