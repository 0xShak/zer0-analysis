-- Persist whether a connected wallet still needs polymarket.com provisioning.
-- When true, the bot refuses trades (a sigType-3 order against an undeployed
-- deposit wallet can never fill) and shows an onboarding prompt instead of
-- letting the CLOB reject the order with "invalid order payload".
alter table tg_wc_sessions
  add column if not exists needs_onboarding boolean not null default false;
