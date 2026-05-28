import { Inngest, eventType, staticSchema } from 'inngest';

export const inngest = new Inngest({ id: 'zer0' });

// v4 EventType pattern: declare each event once and reuse as a trigger
// and as a typed payload for inngest.send().
export const chatMessageReceived = eventType('chat/message.received', {
  schema: staticSchema<{
    sessionId: string;
    userId: string | null;
    channel: 'web' | 'telegram';
    // Telegram-only: the chat id the bot must reply into. Populated by the
    // Telegram message handler so chat-respond can route the outbound row.
    telegramChatId?: number | null;
    // Free-text market the user referenced (intent.market_query, falling back
    // to the raw message). chat-respond uses it to pull live Polymarket data
    // into the prompt. Optional — older senders may omit it.
    marketQuery?: string | null;
  }>(),
});

export const brainTickRequested = eventType('brain/tick.requested', {
  schema: staticSchema<Record<string, never>>(),
});

// Fired once a sim is paid-for (or free, when the payment gate is off). The
// pending_sims row is the source of truth, so the payload is just its id —
// sim-run loads everything else from the row. Sent by the Telegram /sim
// handler and the web /api/sim route.
export const simRequested = eventType('sim/requested', {
  schema: staticSchema<{
    pendingSimId: string;
  }>(),
});

// Fired by the Telegram /sim pay handler the moment it asks the wallet to send,
// BEFORE (and independent of) any wallet-returned tx hash. The durable
// sim-verify-payment function scans Base for the payer's $ZER0 Transfer to the
// sink and enqueues the run when it lands — so a dropped/timed-out WalletConnect
// response can no longer lose a payment that actually mined.
export const simPaymentSubmitted = eventType('sim/payment.submitted', {
  schema: staticSchema<{
    pendingSimId: string;
    expectedFrom: string; // payer EOA (session.eoaAddress) — REQUIRED for attribution
    sink: string; // pending_sims.pay_to_address
    amountBaseUnits: string; // stringified bigint
    fromBlock: string; // chain tip when Pay was tapped (stringified bigint)
    txHash?: string | null; // fast-path hash if the wallet returned one
  }>(),
});
