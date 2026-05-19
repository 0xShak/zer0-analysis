// Centralised env access. Throws clearly when a required var is missing.

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function opt(name: string): string | undefined {
  return process.env[name];
}

export const env = {
  // Public — safe to expose to the browser.
  NEXT_PUBLIC_SUPABASE_URL: opt('NEXT_PUBLIC_SUPABASE_URL') ?? '',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: opt('NEXT_PUBLIC_SUPABASE_ANON_KEY') ?? '',
  NEXT_PUBLIC_APP_URL: opt('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000',

  // Server-only — readers should call these via getters below to surface
  // a useful error when the var is unset during a request.
  get SUPABASE_SERVICE_KEY() { return need('SUPABASE_SERVICE_KEY'); },
  get GROQ_API_KEY() { return need('GROQ_API_KEY'); },
  get OPENAI_API_KEY() { return need('OPENAI_API_KEY'); },
  get COINBASE_COMMERCE_API_KEY() { return need('COINBASE_COMMERCE_API_KEY'); },
  get COINBASE_WEBHOOK_SECRET() { return need('COINBASE_WEBHOOK_SECRET'); },
  get TELEGRAM_BOT_TOKEN() { return need('TELEGRAM_BOT_TOKEN'); },
  get RELAY_PRIVATE_KEY() { return need('RELAY_PRIVATE_KEY'); },
  get INNGEST_EVENT_KEY() { return need('INNGEST_EVENT_KEY'); },
  get INNGEST_SIGNING_KEY() { return need('INNGEST_SIGNING_KEY'); },
};
