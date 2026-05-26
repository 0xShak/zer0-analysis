# ZER0 Telegram Bot — Per-User Polymarket CLOB Credentials (Engineer Handoff)

> **Purpose of this doc:** hand off ONE remaining task to the next engineer with
> full context, so it can be implemented without re-deriving everything. Read it
> top to bottom once before touching code. Line numbers may have drifted — verify
> against the current source.

---

## TL;DR

The Telegram bot can build a structurally-valid Polymarket V2 order and get it all
the way to the CLOB, but the CLOB rejects it with:

> **"the order signer address has to be the address of the api key"**

**Root cause:** the bot authenticates every user's order with a single, shared,
**relay-derived** API key (`POLYMARKET_API_KEY/SECRET/PASSPHRASE`, owned by the relay
address `POLYMARKET_RELAYER_API_KEY_ADDRESS` = `0x20da…`). Polymarket V2 requires the
API key's owner address to **equal the order's `signer`**. A shared key can't satisfy
that for arbitrary users.

**The task:** derive **per-user** CLOB L2 credentials at `/connect` (one extra
WalletConnect signature), bound to the user's trading-wallet address, store them
per-user, and use them in `post-order.ts` instead of the shared relay creds. This is
the exact "long-term" path that `src/telegram-bot/polymarket/api-creds.ts` already
documents in its header comment.

This is believed to be the **last** blocker — wallet resolution and order-payload
shape are already fixed and verified (see "Already done" below).

---

## Background — the full journey (so you trust the diagnosis)

Symptom: every trade through the bot returned `Invalid order payload` (a generic CLOB
400). Three separate bugs were found and fixed in order; each fix uncovered the next
layer:

1. **Dead wallet-resolution endpoint.** `resolve-wallet.ts` called
   `https://data-api.polymarket.com/resolve/{eoa}`, which **does not exist** (404 for
   every address). The code treated 404 as "new user" and fell back to
   `funder = signer = raw EOA, signatureType = 3` — a structurally invalid order
   (sigType 3 requires `maker`/`signer` to be a deployed CREATE2 wallet contract, never
   a raw EOA). → **FIXED** (see below): now derives proxy/safe/deposit addresses
   deterministically and detects the deployed one on-chain via `getCode`.

2. **Wire-body shape drift.** `post-order.ts buildWireBody` sent `salt` as a **string**
   and **omitted `postOnly`**. Polymarket's own serializer
   (`@polymarket/clob-client-v2 → orderToJsonV2`) sends `salt` as a **number** and
   always includes `postOnly`. → **FIXED**: `buildWireBody` now mirrors `orderToJsonV2`
   exactly.

3. **Shared API key (THIS TASK).** With the maker/signer and payload now correct, the
   CLOB advanced to authenticating the request and rejected it because the API key
   owner ≠ order signer. → **NOT DONE — implement this.**

The error changing from `Invalid order payload` → `the order signer address has to be
the address of the api key` is the proof that #1 and #2 are genuinely fixed and we've
reached the auth layer.

---

## Already done (DO NOT redo — currently uncommitted in the working tree)

These changes are in the working tree (branch `feat/trade-onramp-and-builder-attribution`),
**not yet pushed to GitHub** (push needs a GitHub token that isn't configured on the VPS).

- `src/telegram-bot/polymarket/resolve-wallet.ts` — rewritten: derives proxy (sigType 1) /
  safe (sigType 2) / deposit (sigType 3) addresses via `@polymarket/builder-relayer-client`
  CREATE2 helpers, detects which is deployed via on-chain `getCode`, disambiguates multiple
  by pUSD balance. `funder` is always a derived contract, never the raw EOA. Probes
  (`codeProbe`/`balanceProbe`) are injectable for tests.
- `src/lib/polymarket/deposit-wallet.ts` — added `deriveProxyWalletAddress`,
  `deriveSafeAddress`, and a generic `isContractDeployed(address)`.
- `src/lib/polymarket/contracts.ts` — added `POLYMARKET_PROXY_FACTORY` /
  `POLYMARKET_SAFE_FACTORY` (Polygon).
- `src/telegram-bot/db/sessions.ts`, `src/lib/database.types.ts`, and migration
  `supabase/migrations/0008_tg_wc_sessions_needs_onboarding.sql` — added `needs_onboarding`.
  **The migration is already applied to the live Supabase DB.**
- `src/telegram-bot/handlers/connect.ts` + `handlers/trade.ts` — persist `needsOnboarding`;
  block trades for un-provisioned wallets.
- `src/telegram-bot/polymarket/post-order.ts` — `buildWireBody` now mirrors `orderToJsonV2`
  (number `salt` + `postOnly`). **Also still contains temporary `[post-order DEBUG]`
  logging** that dumps the POST URL/headers/body/response to stderr — keep it while
  implementing this task (it's how you'll see the next error), remove before final prod.
- `src/lib/polymarket/clob.ts` — `orderBuilderCode()` stamps the configured builder code
  into the order's `builder` field (separate "builder attribution" change; structurally fine,
  the SDK passes `builder` through).
- `tests/resolve-wallet.test.ts` — 7 passing unit tests for the resolver branches.
- `zer0-persona.md` — persona rewrite so chat guides users into the trade flow (unrelated to
  this task; takes effect only on a Vercel deploy since chat runs there).

---

## The task: per-user CLOB API credentials

### Why (the requirement)

Confirmed against the SDK (`@polymarket/clob-client-v2`):

- `createApiKey(nonce)` / `deriveApiKey(nonce)` build **L1 headers** by signing
  Polymarket's `ClobAuth` EIP-712 message with the user's signer, then hit
  `POST /auth/api-key` / `GET /auth/derive-api-key`. The returned key is **bound to the
  signing address** (or to an explicit `address` override — see subtlety).
- `postOrder` builds **L2 headers** (HMAC over the body using the key's secret) and sends
  `POLY_API_KEY` + `POLY_ADDRESS`. The CLOB requires the key's bound address to equal the
  order's `signer`.

The bot currently skips L1 entirely and reuses the relay's key for everyone
(`api-creds.ts:getApiCredsForEoa` ignores its `eoa` arg and returns env creds). Hence the
mismatch.

### Design

At `/connect`, after `resolveWallet` succeeds and is NOT `needsOnboarding`:

1. Build the `ClobAuth` EIP-712 typed-data (below), bound to the correct address (see
   subtlety), and have the **user's wallet sign it over WalletConnect** — reuse
   `requestEip712Sig({ topic, eoa, typedData })` in `src/telegram-bot/wc/sign.ts` (the same
   path used for order signing).
2. Build L1 headers: `POLY_ADDRESS`, `POLY_SIGNATURE` (the ClobAuth signature),
   `POLY_TIMESTAMP`, `POLY_NONCE`.
3. Call Polymarket to derive the L2 creds:
   - `GET https://clob.polymarket.com/auth/derive-api-key` with the L1 headers
     (deterministic — returns the same key for the same address every time), **or**
   - `POST https://clob.polymarket.com/auth/api-key` to create, falling back to derive
     (mirror `createOrDeriveApiKey`). Derive is simpler and idempotent; prefer it.
   - Response: `{ apiKey, secret, passphrase }` (note: the create endpoint returns
     `apiKey`; the SDK maps it to `key`).
4. Store per-user in a new table `tg_clob_api_creds` keyed by `telegram_user_id` (or by
   wallet address). Suggested columns: `telegram_user_id` (PK/FK), `signer_address`,
   `api_key`, `api_secret`, `api_passphrase`, `created_at`. **These are secrets** — same
   sensitivity as the env creds; store via the service-role client only, never expose.
5. Rework `api-creds.ts:getApiCredsForEoa` (or add `getApiCredsForUser`) to read the
   per-user row first, falling back to the env relay creds only if absent (keep the
   fallback so existing flows don't hard-break).
6. In `post-order.ts`, the L2 `POLY_ADDRESS` header and the `owner` field must correspond
   to the per-user key. Today `POLY_ADDRESS = order.signer` and `owner = creds.apiKey` —
   with per-user creds bound to `order.signer` these line up. **Verify against the live
   CLOB** (see subtlety + verification).

### The `ClobAuth` EIP-712 message (from `clob-client-v2/dist/signing/eip712.js`)

```
domain: { name: "ClobAuthDomain", version: "1", chainId: 137 }
primaryType: "ClobAuth"
types: {
  ClobAuth: [
    { name: "address",   type: "address" },
    { name: "timestamp", type: "string"  },
    { name: "nonce",     type: "uint256" },
    { name: "message",   type: "string"  },
  ]
}
value: {
  address:   <bound address>,            // see subtlety
  timestamp: <unix seconds, as string>,  // must match POLY_TIMESTAMP
  nonce:     0,                           // default 0
  message:   MSG_TO_SIGN                  // read the exact string from
                                          // clob-client-v2/dist/signing/constants.js
}
```

L1 headers to send to `/auth/derive-api-key`:
`POLY_ADDRESS = <bound address>`, `POLY_SIGNATURE = <the ClobAuth sig>`,
`POLY_TIMESTAMP = <same unix seconds>`, `POLY_NONCE = 0`.

The bot has WalletConnect only (no private key), so you cannot hand the SDK an ethers/viem
signer. Build the typed-data above, sign via `requestEip712Sig`, and call `/auth/...`
**manually** (same philosophy as `post-order.ts`, which hand-builds the request to control
exact bytes). `buildPolyHmacSignature` in `src/telegram-bot/polymarket/hmac.ts` is already
available for the L2 HMAC at post time.

### ⚠️ The key subtlety — which address the key binds to

`buildClobEip712Signature(signer, chainId, ts, nonce, address)` and
`createL1Headers(..., address)` both accept an **optional `address` override** (defaults to
the signer's own EOA). The CLOB wants the key's bound address to equal `order.signer`:

- **sigType 1 (proxy) / sigType 2 (safe):** `order.signer = EOA`. Bind to the EOA
  (`address` = EOA = default). Clean.
- **sigType 3 (deposit wallet):** `order.signer = the deposit-wallet contract`. The key
  must bind to that contract address, while the **EOA** produces the signature. So set
  `address = funder` (the deposit wallet) in BOTH the ClobAuth `value.address` and the
  `POLY_ADDRESS` header, signed by the EOA over WC. **This (EOA signs, key bound to the
  deposit wallet it owns) MUST be verified against the live CLOB** — it is the one
  unproven assumption in this plan. The SDK's own `createApiKey` does NOT pass `address`,
  so the deposit-wallet binding is not exercised by the default SDK path. If the derive
  call rejects the override, investigate how Polymarket's web app authorizes deposit-wallet
  trading (it must do something equivalent) and mirror it.

In short: **bind the key to `resolution.signer` (= the order's `signer` field), signing
with the EOA.** Then `POLY_ADDRESS` at post time should also be that same address.

### The test wallet (real, on the VPS)

EOA `0x6816471e48a6b14df63d3e213d22b34497f8f331` resolves (after the fix) to a **deployed
deposit wallet** `0x210B1c77D0D2B832e0b7ee717f7Dd7F12B4Fe9E9`, sigType 3. So the **first**
real end-to-end test exercises exactly the sigType-3 binding subtlety above. Confirm the
deposit wallet actually holds pUSD before expecting a fill.

---

## Verification

1. **Derive in isolation first** (cheap, no DB): write a throwaway script that builds the
   ClobAuth typed-data for the test wallet, has it signed (you'll need the live bot + a real
   `/connect` to get a WC signature, or temporarily sign with a known key in a scratch test),
   and calls `/auth/derive-api-key`. Confirm you get `{apiKey, secret, passphrase}` back for
   `address = 0x210B…` (the deposit wallet). If that call succeeds, the subtlety is resolved.
2. **End-to-end:** `/connect` (now 2 prompts: WC connect + ClobAuth signature) → confirm a
   `tg_clob_api_creds` row is written → place a small trade ($1) → expect a **fill** or an
   **INSUFFICIENT_BALANCE / allowance** error, **not** an auth error. Read the
   `[post-order DEBUG]` lines in `/root/.pm2/logs/zer0-telegram-bot-error.log` to confirm the
   request and the CLOB response.
3. Unit-test the new creds-derivation module with an injected signer/fetch (follow the
   pattern in `tests/resolve-wallet.test.ts`; tests live in `tests/`, use the `@/` alias,
   run with `pnpm test`).

---

## Operational notes / gotchas (READ THESE — they cost time to rediscover)

- **The bot runs under PM2**, process name `zer0-telegram-bot` (id 0). **NOT tmux.**
  - Restart to load code changes: `pm2 restart zer0-telegram-bot` (it runs `tsx`, which
    reads source fresh at start — no build step needed).
  - Logs: `/root/.pm2/logs/zer0-telegram-bot-out.log` (stdout) and `-error.log` (stderr;
    `console.error`, including `[post-order DEBUG]`, goes here).
  - **Do NOT start the bot in tmux / a second process.** Two pollers on the same Telegram
    token cause 409 conflicts and crash-loop both. (`zer0-inngest-dev` is a separate PM2
    process — the local Inngest dev server. Leave it.)
- **Env file is `.env.local`** (loaded via `tsx --env-file=.env.local`; the `bot` script in
  package.json). There is **no `.env`**. Relevant keys already present: `POLYMARKET_API_KEY`,
  `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE` (shared relay creds — the thing you're
  replacing), `POLYMARKET_RELAYER_API_KEY_ADDRESS` (= `0x20da…`, relay addr), `RELAY_PRIVATE_KEY`,
  `WALLETCONNECT_PROJECT_ID`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, etc.
- **tsconfig `target` < ES2020:** bigint literals (`0n`, `5n`) DO NOT COMPILE (`tsc`/`next build`
  fail with TS2737) even though `vitest`/esbuild accepts them. Use `BigInt(0)`. Always run
  `npx tsc --noEmit` after editing, not just `pnpm test`.
- **Architecture split:** trades run entirely in the always-on bot worker (this PM2 process).
  Only *chat* uses the Inngest→Vercel→Supabase-Realtime round trip. The CLOB submit may be
  geoblocked depending on egress; `POLYMARKET_RELAY_URL` (currently unset) forwards `/order`
  through a relay if set — see `post-order.ts:postViaRelay`. Your new `/auth/derive-api-key`
  call egresses directly; if `/order` ever needs the relay for geo reasons, the auth call
  likely does too.
- This repo is a **modified Next.js** (see `AGENTS.md`): read `node_modules/next/dist/docs/`
  before writing Next.js code. (Not relevant to this bot-worker task, but heed it if you touch
  routes.)

---

## Key file & symbol references

- `src/telegram-bot/polymarket/api-creds.ts` — `getApiCredsForEoa` (the shared-creds fallback to rework).
- `src/telegram-bot/polymarket/post-order.ts` — `postOrder`, `buildWireBody`, the `POLY_ADDRESS`/`owner`
  header wiring, and the temp `[post-order DEBUG]` logging.
- `src/telegram-bot/polymarket/hmac.ts` — `buildPolyHmacSignature(secret, ts, method, path, body)` (L2 HMAC).
- `src/telegram-bot/wc/sign.ts` — `requestEip712Sig({ topic, eoa, typedData })` (sign arbitrary EIP-712 over WC).
- `src/telegram-bot/handlers/connect.ts` — `/connect` flow; add the ClobAuth signature + creds derivation here.
- `src/telegram-bot/handlers/confirm.ts` — order signing + submit path; calls `getApiCredsForEoa`.
- `src/telegram-bot/polymarket/resolve-wallet.ts` — returns `{ funder, signer, signatureType, walletType, needsOnboarding }`.
- `src/telegram-bot/db/sessions.ts` — `tg_wc_sessions` helpers (pattern to follow for the new creds table).
- SDK reference (read-only, for the canonical behavior):
  - `node_modules/@polymarket/clob-client-v2/dist/headers/index.js` — `createL1Headers` / `createL2Headers`.
  - `.../dist/signing/eip712.js` — `buildClobEip712Signature` (ClobAuth).
  - `.../dist/signing/constants.js` — `MSG_TO_SIGN` (exact message string).
  - `.../dist/client.js` — `createApiKey` / `deriveApiKey` / `createOrDeriveApiKey` (~lines 195-228), `postOrder` (~525).
  - `.../dist/endpoints.js` — `/auth/api-key`, `/auth/derive-api-key`.
  - `.../dist/types/ordersV2.js` — `orderToJsonV2` (the wire body shape `post-order.ts` mirrors).

---

## UX impact (already discussed with the product owner)

First-time `/connect` becomes **2 wallet prompts**: (1) WalletConnect connection approval,
(2) the one-time `ClobAuth` authorize-trading signature. The derived key is cached per-user,
so this only happens once per wallet. Every subsequent **trade** is still a single prompt
(the per-trade order signature), unchanged.
