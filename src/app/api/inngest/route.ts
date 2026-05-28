import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { brainTick } from '@/lib/inngest/functions/brain-tick';
import { chatRespond } from '@/lib/inngest/functions/chat-respond';
import { settlePredictions } from '@/lib/inngest/functions/settle-predictions';
import { simRun } from '@/lib/inngest/functions/sim-run';
import { simVerifyPayment } from '@/lib/inngest/functions/sim-verify-payment';
import { xBroadcast } from '@/lib/inngest/functions/x-broadcast';

// Vercel's default function duration is 10s on Hobby, 15s on Pro — far too
// short for Inngest steps that call OpenAI gpt-5.5-pro (reasoning, can take
// 20-40s). Set to 60s, the Hobby max. Each Inngest step.run() is a separate
// Vercel invocation, so each step gets its own 60s budget.
export const maxDuration = 60;
export const runtime = 'nodejs';

// SECURITY: serve() only verifies request signatures when it has a signing key
// AND is not in dev mode. In dev mode (INNGEST_DEV set, or NODE_ENV!=production)
// it trusts every request — anyone who can reach this endpoint could directly
// invoke brain-tick / sim-run / x-broadcast / chat-respond. That's only
// acceptable for the local dev topology where the port isn't network-exposed.
// In production we MUST be in verified cloud mode: fail the build/boot loudly
// rather than ship an open function-invocation endpoint. (The local `next dev`
// VPS runs with NODE_ENV=development, so this guard doesn't fire there.)
if (process.env.NODE_ENV === 'production') {
  const dev = process.env.INNGEST_DEV;
  const devForced =
    dev != null &&
    dev !== '' &&
    dev !== '0' &&
    dev.toLowerCase() !== 'false';
  if (devForced) {
    throw new Error(
      '[inngest] INNGEST_DEV must not be set in production — it disables request-signature verification on /api/inngest',
    );
  }
  if (!process.env.INNGEST_SIGNING_KEY) {
    throw new Error(
      '[inngest] INNGEST_SIGNING_KEY is required in production so /api/inngest can verify Inngest-signed requests',
    );
  }
}

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    brainTick,
    chatRespond,
    settlePredictions,
    simRun,
    simVerifyPayment,
    xBroadcast,
  ],
});
