-- L3 (audit2.md): secrets at rest are now AES-256-GCM encrypted in app code
-- (tg_clob_api_creds + the walletconnect_kv session store). Existing rows are
-- plaintext and were written before the CLOB_CREDS_ENC_KEY scheme existed, so
-- clear them to force one clean re-/connect — after which every stored value is
-- an encrypted envelope and no plaintext credential lingers in the DB.
--
-- This is the "force re-/connect" rollout (no decrypt-migration). The bot's
-- read path is back-compatible with plaintext, so this delete is what actually
-- removes the lingering cleartext rather than a correctness requirement.
--
-- Order: KV + creds first, then the session pointers that depend on a live WC
-- session. Dropping walletconnect_kv invalidates every SignClient session, so
-- tg_wc_sessions rows are dead anyway — clear them too so /connect starts fresh.

delete from public.tg_clob_api_creds;
delete from public.walletconnect_kv;
delete from public.tg_pending_trades;
delete from public.tg_wc_sessions;
