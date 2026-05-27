# MiroShark × ZER0 — Handoff #1 (Track A)

Sync doc between the VPS/repo Claude (wrote this) and laptop Claude. Source spec:
`/root/miroshark-zero.html`. This covers **Track A only** (the ZER0 app repo
work). Track B = standing up MiroShark on the VPS (not this repo).

- **Repo:** `/root/zer0-backend`
- **Branch:** `feat/miroshark-sim-integration` (commit on this branch; not merged to `main`)
- **Status:** feature complete + verified against the real MiroShark source.
  `next build` ✓ · TypeScript ✓ · ESLint ✓ · 57/57 tests pass.
- **Migration `0011` pushed to Supabase:** ✅ (done 2026-05-27).
- **Live?** No — waiting on Track B to hand back `MIROSHARK_API_URL` + `MIROSHARK_API_TOKEN` (see Blockers).

---

## What this feature does

Let ZER0 users run **MiroShark swarm simulations** from **Telegram** (`/sim <scenario>`
or a `run_sim` intent) or the **web** (`/sim` form → `/sim/[id]` result view). A
durable Inngest function (`sim-run`, executes on Vercel) drives the MiroShark
lifecycle over HTTPS and delivers the result (summary + share card + live watch
link) async — Telegram via `outbound_messages`, web via polling. Pay-per-sim
with **$ZER0 on Base** is built but **gated OFF by default** (free runs) until
product inputs land.

---

## Files (what to read first → rest)

**Core orchestration**
- `src/lib/miroshark/{client,types}.ts` — typed HTTP client, the MiroShark boundary.
- `src/lib/inngest/functions/sim-run.ts` — the durable orchestrator (read this to understand the flow).
- `src/lib/inngest/client.ts` — added `simRequested` (`sim/requested`) event.
- `src/app/api/inngest/route.ts` — registered `simRun`.

**DB**
- `supabase/migrations/0011_miroshark_sims.sql` — `pending_sims` + `simulations` tables, `sim_state` enum.
- `src/lib/database.types.ts` — typed schema (both tables + enum added).
- `src/lib/sims/db.ts` — shared row helpers (bot + Vercel + web).
- `src/lib/sims/request.ts` — `createSimRequest` / `markSimPaidAndEnqueue` (the payment gate lives here, ONE place).

**Telegram**
- `src/telegram-bot/handlers/sim.ts` — `/sim` command + `run_sim` intent + payment callback.
- `src/telegram-bot/handlers.ts` — registered `/sim` + `sim:` callback + HELP text.
- `src/telegram-bot/handlers/ask.ts` — `run_sim` intent branch.
- `src/telegram-bot/intent/parse.ts` — added `run_sim` intent + `scenario` field.
- `src/telegram-bot/trade-rate-limit.ts` — `allowSimRequest` (5/day).

**Web**
- `src/app/api/sim/route.ts` — POST trigger.
- `src/app/api/sim/[id]/route.ts` — GET status (id = pending_sim id).
- `src/app/api/sim/verify/route.ts` — POST web payment verification.
- `src/app/sim/page.tsx` — trigger form.
- `src/app/sim/[id]/page.tsx` — result view (polls, embeds share card, links /watch).

**Payment ($ZER0 on Base, gated off)**
- `src/lib/web3/zer0-payment.ts` — on-chain verify (viem + Base RPC).
- `src/telegram-bot/wc/pay.ts` — WC `eth_sendTransaction` on Base + verify.
- `src/telegram-bot/wc/pair.ts` — Base added as an OPTIONAL WC namespace.
- `src/lib/env.ts`, `.env.example` — new env vars.

**Tests:** `tests/miroshark-client.test.ts`, `tests/intent-run-sim.test.ts`.

---

## Verified against github.com/aaronjmars/MiroShark

MiroShark is a **Flask** app, API on `:5001`. I cloned + read the routes and the
`backend/scripts/test_e2e_api.py` the spec's §5 was derived from.

1. **All §5 endpoints/bodies match** the real routes (ontology / build / task /
   create / prepare / prepare-status / start / run-status / signal.json /
   polymarket.json / share-card.png / `/watch`).
2. **No auth on read/run endpoints.** `MIROSHARK_API_TOKEN` is the **reverse-proxy**
   bearer Track B puts in front (the service is otherwise open). MiroShark issues
   no token of its own for these.
3. **Text contract resolved.** `ontology/generate` has no raw `text` field, but
   `.txt` is an allowed upload type → the client sends the scenario as a
   `scenario.txt` Blob under `files`. Correct, not a guess. (Alt path that also
   works: `url_docs` JSON with inline `{title,text}` — `url` optional.)
4. **PUBLISH GATE (the big one §5 missed).** `signal.json`, `polymarket.json`,
   `share-card.png`, and a meaningful `/watch` **all require `is_public=true`**
   (else 404 / bare frame). The e2e never publishes (only tests the report path),
   so the spec didn't know. `sim-run` now calls `POST /api/simulation/<id>/publish`
   right after create. That route needs `Authorization: Bearer $MIROSHARK_ADMIN_TOKEN`
   (fail-closed, 503 if unset) — a separate admin secret in MiroShark's OWN env.
5. **Done states.** Graph + prepare polls finish on `'completed'` **or `'ready'`**
   (per the e2e's logic) — both handled.

---

## Lifecycle (sim-run)

```
claim (mark RUNNING, create simulations row)
 → ontology  POST /api/graph/ontology/generate (files=scenario.txt + simulation_requirement)
 → graph build POST /api/graph/build → poll GET /api/graph/task/{id} (completed|ready)
 → create    POST /api/simulation/create (project_id)
 → PUBLISH   POST /api/simulation/<id>/publish {public:true}   ← required, best-effort
 → prepare   POST /api/simulation/prepare → poll /prepare/status (completed|ready)
 → start     POST /api/simulation/start {platform:'parallel', max_rounds:3, force:true}
             → poll GET /<id>/run-status until runner_status ∈ {completed,idle,stopped}
 → results   GET /<id>/signal.json + /polymarket.json ; build /share-card.png + /watch URLs
 → summarize (Groq, llama-8b, failure-tolerant)
 → persist COMPLETED + deliver (outbound_messages / web message)
```
Each phase is its own `step.run()`; polls use `step.sleep('5s')`. `onFailure`
marks FAILED + notifies the user. `retries: 2` (a completed step is memoized, so
a retry resumes at the failed phase — never re-burns OpenRouter spend).

---

## Blockers to go-live (none are code)

1. **Track B §9 deliverables → env:** `MIROSHARK_API_URL`, `MIROSHARK_API_TOKEN`.
2. **VPS-side requirement (new, found from source):** set MiroShark's
   `MIROSHARK_ADMIN_TOKEN` **equal to the proxy bearer** (= our `MIROSHARK_API_TOKEN`),
   or `/publish` 401s and the share card / watch / summary won't render.
3. **Confirm a real sim completes** end-to-end once the URL is live (Track B §4 step 5).

## To enable payment (optional — currently free)
Set `ZER0_TOKEN_ADDRESS`, `ZER0_SIM_SINK_ADDRESS`, `ZER0_SIM_PRICE` (Base) and
flip `ZER0_SIM_PAYMENT_ENABLED=true`. Note: Base is now an *optional* WC namespace,
so existing Polygon-only wallet sessions must re-`/connect` to pay.

---

## New env vars (see `.env.example`)

| Var | Who sets it | Notes |
|---|---|---|
| `MIROSHARK_API_URL` | Track B | public HTTPS base |
| `MIROSHARK_API_TOKEN` | Track B | proxy bearer; sent on every request |
| `ZER0_SIM_PAYMENT_ENABLED` | us | default `false` = free sims |
| `BASE_RPC_URL` | us | default `https://mainnet.base.org` |
| `ZER0_TOKEN_ADDRESS` / `ZER0_SIM_SINK_ADDRESS` / `ZER0_SIM_PRICE` | product (§8) | only when payment on |

On the **VPS** (not this repo): `MIROSHARK_ADMIN_TOKEN` must equal the proxy bearer.

---

## Open questions / possible next work (for laptop Claude)

- **Deliver the watch link early?** Right now we publish during the run but only
  send the user one message at completion. Could send "watch it live: <url>" the
  moment the run starts (one extra outbound). Low effort, nice UX.
- **Ontology quality from a one-sentence scenario.** A single sentence is thin
  input for MiroShark's ontology generator. Quality TBD until we run a real one;
  the `url_docs` inline-text path or enriching the scenario could help.
- **Payment refund on failure.** If a paid sim FAILs, we notify but don't refund.
  Out of scope for v1; flag if product wants it.
- **Web payment UI.** `/api/sim/verify` exists, but `/sim` page only shows a quote
  when payment is on — the actual browser WC send-on-Base flow isn't wired (TG is).
- **No expiry cron for `pending_sims`** yet (helper `expireStalePendingSims` exists
  in `lib/sims/db.ts`, unused). Add to the bot's cron if AWAITING_PAYMENT rows pile up.

## How to verify locally
```
pnpm test            # 57 tests
npx tsc --noEmit     # (ignore the stale .next/types/validator.ts line; regenerated by build)
pnpm build           # full type check + compile
pnpm lint
```

## Project memory
`/root/.claude/projects/-root/memory/miroshark-sim-integration.md` mirrors this
(kept in sync). `MEMORY.md` indexes it.
