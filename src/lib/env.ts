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

  // Base mainnet JSON-RPC, used to verify the $ZER0 pay-per-sim transfer
  // (lib/web3/zer0-payment). Defaults to Base's public RPC; override with a
  // private RPC if rate-limits bite under load.
  BASE_RPC_URL: process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',

  // Max block span per eth_getLogs call when scanning Base for a sim payment.
  // Free RPC tiers cap getLogs ranges (QuickNode Discover = 5, Alchemy free =
  // 10), so the payment scanner walks the window in chunks this size. Default 10
  // (fits Alchemy free); set to 5 for QuickNode Discover, or raise it on a paid
  // plan to scan in fewer calls.
  BASE_LOG_SCAN_CHUNK: process.env.BASE_LOG_SCAN_CHUNK ?? '10',

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
  // Master switch for the mention-respond cron (x-mentions Inngest fn).
  // Independent of X_POSTING_ENABLED so replies can be enabled/disabled without
  // touching the signal/digest broadcast. When not 'true', the fn no-ops.
  X_MENTIONS_ENABLED: process.env.X_MENTIONS_ENABLED ?? 'false',
  // Master switch for OPINIONATED mention replies: when 'true', a grounded
  // mention is run through web research + the reply-analyzer (a probability
  // estimate vs the market price → fair/over/under verdict) instead of just
  // quoting the price. When 'false' (default) the mention cron behaves exactly
  // as before. Independent of X_MENTIONS_ENABLED so it can ship dark.
  X_MENTION_ANALYSIS_ENABLED: process.env.X_MENTION_ANALYSIS_ENABLED ?? 'false',
  // @atzer0_BOT's numeric account id, used as the path param for
  // GET /2/users/:id/mentions. Mint-free to obtain: `npm run x-whoami` prints
  // it. Empty by default so the mention-respond fn skips cleanly until it's set.
  X_BOT_USER_ID: process.env.X_BOT_USER_ID ?? '',
  // OAuth 1.0a user-context credentials. API key/secret are @0xAhrii's app
  // (the X Developer account that holds the Pay-Per-Use project); the access
  // token/secret are @atzer0_BOT's per-user tokens — the persona the tweets
  // appear under. Do NOT use the app owner's own access tokens here.
  get X_API_KEY() { return need('X_API_KEY'); },
  get X_API_SECRET() { return need('X_API_SECRET'); },
  get X_ACCESS_TOKEN() { return need('X_ACCESS_TOKEN'); },
  get X_ACCESS_TOKEN_SECRET() { return need('X_ACCESS_TOKEN_SECRET'); },

  // ---- Web research (Tavily) + opinionated reply analysis ----
  // Feeds fresh news context into ZER0's mention takes. RESEARCH_ENABLED gates
  // the search call independently of X_MENTION_ANALYSIS_ENABLED, so analysis
  // can run prompt-only (no web) if research is off or rate-limited.
  RESEARCH_ENABLED: process.env.RESEARCH_ENABLED ?? 'false',
  // Tavily API key — only read when RESEARCH_ENABLED is 'true'.
  get RESEARCH_API_KEY() { return need('RESEARCH_API_KEY'); },
  RESEARCH_BASE_URL: process.env.RESEARCH_BASE_URL ?? 'https://api.tavily.com',
  // Model for the opinionated mention take (probability estimate + verdict).
  // Separate from the brain's ANALYZER_MODEL so public takes run on a cheaper
  // model than the trading brain. Must exist in cost/openai-pricing.ts.
  MENTION_ANALYSIS_MODEL: process.env.MENTION_ANALYSIS_MODEL ?? 'gpt-5.5',

  // ---- MiroShark (Track B / VPS) — run-a-sim integration ----
  // Public base URL + bearer token for the self-hosted MiroShark API. Both
  // are handed back by the VPS Claude (miroshark-zero.html §9). Getters so an
  // unset value fails loudly the moment the sim client makes a request, rather
  // than sending an unauth'd call to undefined.
  //
  // VERIFIED against github.com/aaronjmars/MiroShark: MiroShark's read/run
  // endpoints have NO auth — MIROSHARK_API_TOKEN is the bearer the VPS reverse
  // proxy enforces (the spec §4 step 4 adds the proxy precisely because the
  // service is otherwise open). The one exception is the publish/resolve/outcome
  // mutation routes, which check `Authorization: Bearer $MIROSHARK_ADMIN_TOKEN`
  // (a separate fail-closed secret in MiroShark's OWN env). We must publish each
  // sim (signal.json / share-card / watch all gate on is_public), so on the VPS
  // set MIROSHARK_ADMIN_TOKEN EQUAL to the proxy bearer — then our single token
  // satisfies both the proxy and MiroShark's admin check.
  get MIROSHARK_API_URL() { return need('MIROSHARK_API_URL'); },
  get MIROSHARK_API_TOKEN() { return need('MIROSHARK_API_TOKEN'); },

  // ---- Pay-per-sim ($ZER0 on Base) ----
  // Master switch. While 'false' (the default), sims run free — the feature
  // can ship + be smoke-tested before the token/price/sink are finalized,
  // mirroring X_POSTING_ENABLED. Flip to 'true' once §8 product inputs land.
  ZER0_SIM_PAYMENT_ENABLED: process.env.ZER0_SIM_PAYMENT_ENABLED ?? 'false',
  // $ZER0 ERC-20 contract on Base. Needed only when the payment gate is on.
  get ZER0_TOKEN_ADDRESS() { return need('ZER0_TOKEN_ADDRESS'); },
  // Where the per-sim fee goes. Defaults to the canonical dead address so every
  // sim fee is burned (Option A): $ZER0's burn() is owner-gated, so a holder
  // can't self-burn — transferring to 0x…dEaD is the trustless, explorer-
  // recognized burn. Override only to point fees at a treasury instead.
  ZER0_SIM_SINK_ADDRESS:
    process.env.ZER0_SIM_SINK_ADDRESS ??
    '0x000000000000000000000000000000000000dEaD',
  // Human-readable $ZER0 amount charged per sim (e.g. '1000'). Multiplied by
  // 10^decimals at verify time. Needed only when the payment gate is on.
  get ZER0_SIM_PRICE() { return need('ZER0_SIM_PRICE'); },

  // ---- PRO unlock paid in $ZER0 on Base (replaces Coinbase/USDC) ----
  // Master switch, mirroring ZER0_SIM_PAYMENT_ENABLED. While 'false' (default),
  // the /api/pro/* routes return payment_disabled so the feature can deploy
  // before the price feed / sink are confirmed. Flip to 'true' once the
  // landing page (zer0-FE) is live and the token/price are finalized.
  ZER0_PRO_PAYMENT_ENABLED: process.env.ZER0_PRO_PAYMENT_ENABLED ?? 'false',
  // USD price PRO is pegged to. The quote converts this to a $ZER0 amount at
  // the live token price, so the dollar value stays ~constant as $ZER0 moves.
  PRO_PRICE_USD: process.env.PRO_PRICE_USD ?? '5',
  // How many days a confirmed PRO payment unlocks.
  PRO_ENTITLEMENT_DAYS: process.env.PRO_ENTITLEMENT_DAYS ?? '30',
  // Where the PRO fee lands. Defaults to the canonical dead address (burn),
  // matching the per-sim sink. Override to point at a treasury instead.
  ZER0_PRO_SINK_ADDRESS:
    process.env.ZER0_PRO_SINK_ADDRESS ??
    '0x000000000000000000000000000000000000dEaD',
  // Live $ZER0/USD price source. Defaults to DexScreener's keyless tokens
  // endpoint; {token} is replaced with ZER0_TOKEN_ADDRESS. Must return the
  // DexScreener `pairs[].priceUsd` shape (see lib/web3/zer0-price.ts).
  ZER0_PRICE_SOURCE_URL:
    process.env.ZER0_PRICE_SOURCE_URL ??
    'https://api.dexscreener.com/latest/dex/tokens/{token}',
  // Comma-separated origins allowed to call the CORS-enabled /api/pro/* routes
  // (the landing site pays cross-origin). '*' allows any — safe here because
  // these routes carry no cookies and verify every payment on-chain.
  PRO_CORS_ORIGINS: process.env.PRO_CORS_ORIGINS ?? '*',
  // Public URL of the pricing page (zer0-FE), linked from the in-app paywall
  // banner so a rate-limited user can go pay in $ZER0.
  NEXT_PUBLIC_PRICING_URL:
    process.env.NEXT_PUBLIC_PRICING_URL ?? 'https://atzer0.xyz/#price',
};
