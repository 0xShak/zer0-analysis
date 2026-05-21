// WalletConnect SignClient singleton for the Telegram bot.
//
// IMPORTANT: this MUST be called at most once per process. The canonical
// failure (walletconnect-monorepo discussion #5587) is calling
// SignClient.init from inside a message handler — the bot then crashes
// after ~2 minutes inside `wt/constructor/resetPingTimeout` with
// `TypeError: i.terminate is not a function`. The fix is the module-level
// promise pattern below: every caller awaits the same in-flight init.

import SignClient from '@walletconnect/sign-client';
import { createAdminClient } from '../../lib/supabase/admin';
import { env } from '../../lib/env';
import { PostgresKeyValueStorage } from './storage';

let clientPromise: Promise<SignClient> | null = null;

const METADATA = {
  name: 'zer0',
  description: 'Autonomous AI agent for Polymarket',
  url: 'https://zer0.app',
  icons: ['https://zer0.app/icon.png'],
};

/**
 * Returns the singleton SignClient. Safe to call from any handler — the
 * first call boots it; subsequent calls reuse. The promise is cached even
 * if init() rejects, but rather than poison the cache we null the slot on
 * failure so a retry can succeed.
 */
export function getSignClient(): Promise<SignClient> {
  if (clientPromise) return clientPromise;
  const supabase = createAdminClient();
  const storage = new PostgresKeyValueStorage(supabase);
  clientPromise = SignClient.init({
    projectId: env.WALLETCONNECT_PROJECT_ID,
    // The WC types narrow this to their own IKeyValueStorage; ours is
    // structurally identical (see storage.ts) so we cast at the boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storage: storage as any,
    metadata: METADATA,
  }).catch((err) => {
    clientPromise = null;
    throw err;
  });
  return clientPromise;
}

/**
 * Wire SignClient session lifecycle events to the bot. Call once at
 * startup, after getSignClient() resolves. The handlers here are
 * intentionally cheap — they delegate to a per-event handler module so
 * the singleton itself doesn't grow business logic.
 */
export async function attachSessionEventHandlers(opts: {
  onSessionDelete?: (topic: string) => void | Promise<void>;
  onSessionExpire?: (topic: string) => void | Promise<void>;
}): Promise<void> {
  const client = await getSignClient();
  if (opts.onSessionDelete) {
    client.on('session_delete', (args) => {
      void opts.onSessionDelete?.(args.topic);
    });
  }
  if (opts.onSessionExpire) {
    client.on('session_expire', (args) => {
      void opts.onSessionExpire?.(args.topic);
    });
  }
}
