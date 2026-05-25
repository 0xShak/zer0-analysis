import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { brainTick } from '@/lib/inngest/functions/brain-tick';
import { chatRespond } from '@/lib/inngest/functions/chat-respond';
import { settlePredictions } from '@/lib/inngest/functions/settle-predictions';

// Vercel's default function duration is 10s on Hobby, 15s on Pro — far too
// short for Inngest steps that call OpenAI gpt-5.5-pro (reasoning, can take
// 20-40s). Set to 60s, the Hobby max. Each Inngest step.run() is a separate
// Vercel invocation, so each step gets its own 60s budget.
export const maxDuration = 60;
export const runtime = 'nodejs';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [brainTick, chatRespond, settlePredictions],
});
