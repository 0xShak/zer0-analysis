// Centralised env access. Throws clearly when a required var is missing.
//
// NEXT_PUBLIC_* vars must be referenced via direct `process.env.NEXT_PUBLIC_X`
// (dot notation, literal key) so Next's build-time static replacement can
// substitute the value into the client bundle. Dynamic access like
// `process.env[name]` defeats that replacement and leaves the variable
// undefined in the browser.

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  // Public — safe to expose to the browser. MUST use direct references.
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',

  // Polygon JSON-RPC endpoint for server-side reads (allowance preflight,
  // balance lookups). Default to Polygon's official public RPC; override
  // with a private RPC (Alchemy/Infura/QuickNode) if rate-limits bite.
  POLYGON_RPC_URL:
    process.env.POLYGON_RPC_URL ?? 'https://polygon-rpc.com',

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

  // Telegram v3 — WalletConnect + region-aware order submission.
  get WALLETCONNECT_PROJECT_ID() { return need('WALLETCONNECT_PROJECT_ID'); },
  // Optional. When set, the bot forwards POST /order through this relay
  // (e.g. a Fly.io container in sa-saopaulo-1) instead of egressing
  // directly. Format: full URL of the relay's `/order` endpoint.
  POLYMARKET_RELAY_URL: process.env.POLYMARKET_RELAY_URL ?? '',
  // HMAC-shared-secret for relay auth. Empty = no auth (use mTLS / private
  // network instead). Set when POLYMARKET_RELAY_URL is set on a public host.
  POLYMARKET_RELAY_SECRET: process.env.POLYMARKET_RELAY_SECRET ?? '',
};
