import { Client, resources, Webhook } from 'coinbase-commerce-node';
import { env } from './env';

let initialized = false;
function ensureClient() {
  if (!initialized) {
    Client.init(env.COINBASE_COMMERCE_API_KEY);
    initialized = true;
  }
}

export async function createCharge(args: {
  sessionId: string;
  walletAddress?: string;
  amountUsd?: string;
}) {
  ensureClient();
  return resources.Charge.create({
    name: 'ZER0 — 30 days unlocked',
    description: 'Unlimited ZER0 chat and trade recommendations for 30 days',
    pricing_type: 'fixed_price',
    local_price: { amount: args.amountUsd ?? '5.00', currency: 'USD' },
    metadata: { sessionId: args.sessionId, walletAddress: args.walletAddress },
    redirect_url: `${env.NEXT_PUBLIC_APP_URL}/payment-success`,
    cancel_url: `${env.NEXT_PUBLIC_APP_URL}/payment-cancelled`,
  });
}

export function verifyWebhook(rawBody: string, signature: string) {
  return Webhook.verifyEventBody(rawBody, signature, env.COINBASE_WEBHOOK_SECRET);
}
