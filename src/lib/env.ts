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

  // ---- Polymarket builder identity (V2 relayer + order attribution) ----
  // Obtained at https://polymarket.com/settings?tab=builder via "Create new" →
  // "View API Details". The HMAC trio (api_key / secret / passphrase) is the
  // long-lived credential set Polymarket uses to authenticate relayer + CLOB
  // writes. The UI literally warns: "Never share your key or put it in client-
  // side code." The browser only sees per-request HMAC signatures returned by
  // our /api/polymarket/builder-sign route — the secret never leaves the
  // server. Server-only — must NOT be prefixed `NEXT_PUBLIC_`.
  get POLYMARKET_BUILDER_API_KEY() { return need('POLYMARKET_BUILDER_API_KEY'); },
  get POLYMARKET_BUILDER_SECRET() { return need('POLYMARKET_BUILDER_SECRET'); },
  get POLYMARKET_BUILDER_PASSPHRASE() {
    return need('POLYMARKET_BUILDER_PASSPHRASE');
  },

  // The builder attribution code (bytes32). Public — it's recorded in every
  // V2 order's `builder` field anyway. Exposed to the browser so clob-client-v2
  // can stamp orders without a round-trip.
  NEXT_PUBLIC_POLYMARKET_BUILDER_CODE:
    process.env.NEXT_PUBLIC_POLYMARKET_BUILDER_CODE ?? '',

  // ---- X (Twitter) auto-posting (lib/x + x-broadcast Inngest fn) ----
  // Master switch. When not 'true', the x-broadcast function no-ops, so this
  // code can ship before credentials are wired without crashing any ticks.
  X_POSTING_ENABLED: process.env.X_POSTING_ENABLED ?? 'false',
  // OAuth 1.0a user-context credentials. API key/secret are @0xAhrii's app
  // (the X Developer account that holds the Pay-Per-Use project); the access
  // token/secret are @atzer0_BOT's per-user tokens — the persona the tweets
  // appear under. Do NOT use the app owner's own access tokens here.
  get X_API_KEY() { return need('X_API_KEY'); },
  get X_API_SECRET() { return need('X_API_SECRET'); },
  get X_ACCESS_TOKEN() { return need('X_ACCESS_TOKEN'); },
  get X_ACCESS_TOKEN_SECRET() { return need('X_ACCESS_TOKEN_SECRET'); },
};
