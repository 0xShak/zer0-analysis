import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { env } from '../env';

// Service-role client — BYPASSES RLS. Use only from trusted server contexts
// (Inngest functions, webhook handlers, the Oracle Cloud workers). Never
// import from a client component.
let cached: SupabaseClient<Database> | undefined;

// Node <22 has no native `WebSocket` global, which the Realtime client
// requires. We lazy-require `ws` only when needed (it's a runtime dep added
// for the Telegram bot) so the Next.js bundle stays unchanged.
function pickRealtimeTransport(): unknown | undefined {
  if (typeof globalThis.WebSocket !== 'undefined') return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ws = require('ws');
    return ws.WebSocket ?? ws.default ?? ws;
  } catch {
    return undefined;
  }
}

export function createAdminClient(): SupabaseClient<Database> {
  if (cached) return cached;
  const transport = pickRealtimeTransport();
  cached = createSupabaseClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      ...(transport
        ? {
            realtime: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              transport: transport as any,
            },
          }
        : {}),
    },
  );
  return cached;
}
