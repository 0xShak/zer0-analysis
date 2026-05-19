import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { brainTick } from '@/lib/inngest/functions/brain-tick';
import { chatRespond } from '@/lib/inngest/functions/chat-respond';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [brainTick, chatRespond],
});
