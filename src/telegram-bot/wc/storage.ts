// Postgres-backed IKeyValueStorage for WalletConnect SignClient.
//
// Why not the default storage:
//   - The default disk-based storage uses better-sqlite3, which requires
//     native compilation; that's flaky on Oracle ARM (the bot's host).
//   - The bot is restarted by PM2 on deploy / crash. In-memory storage
//     would drop every active WalletConnect session and force every linked
//     user to /connect again. Postgres survives both.
//
// Interface contract: IKeyValueStorage from @walletconnect/keyvaluestorage.
// We declare a structural type locally so this module's own typecheck
// doesn't depend on the WC package being importable at compile time.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../../lib/database.types';
import { decryptSecret, encryptSecret } from '../../lib/crypto/secret-box';

// WC SignClient session material (keychain symKeys, session state) is secret, so
// the stored `value` is encrypted at rest (audit2.md L3): we keep a tiny
// { enc: <envelope> } jsonb wrapper instead of the raw value. Reads stay
// back-compatible with any pre-migration plaintext row (returned as-is), so a
// rollout can't break a live SignClient mid-session; the 0014 migration clears
// old rows to force a clean re-/connect.
function encodeValue(value: unknown): Json {
  return { enc: encryptSecret(JSON.stringify(value ?? null)) } as unknown as Json;
}
function decodeValue<T>(value: unknown): T {
  if (
    value &&
    typeof value === 'object' &&
    'enc' in value &&
    typeof (value as { enc: unknown }).enc === 'string'
  ) {
    return JSON.parse(decryptSecret((value as { enc: string }).enc)) as T;
  }
  return value as T; // pre-migration plaintext
}

// Structural copy of @walletconnect/keyvaluestorage's IKeyValueStorage so
// the adapter can be typechecked without the runtime dep.
export interface IKeyValueStorage {
  getKeys(): Promise<string[]>;
  getEntries<T = unknown>(): Promise<[string, T][]>;
  getItem<T = unknown>(key: string): Promise<T | undefined>;
  setItem<T = unknown>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class PostgresKeyValueStorage implements IKeyValueStorage {
  constructor(private readonly supabase: SupabaseClient<Database>) {}

  async getKeys(): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('walletconnect_kv')
      .select('key');
    if (error) throw error;
    return (data ?? []).map((r) => r.key);
  }

  async getEntries<T = unknown>(): Promise<[string, T][]> {
    const { data, error } = await this.supabase
      .from('walletconnect_kv')
      .select('key,value');
    if (error) throw error;
    return (data ?? []).map((r) => [r.key, decodeValue<T>(r.value)]);
  }

  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    const { data, error } = await this.supabase
      .from('walletconnect_kv')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    return decodeValue<T>(data.value);
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    // Select-then-insert/update — mirrors the db.ts house style. Without
    // an .upsert() the second writer would lose a race, but in practice
    // SignClient only writes from a single in-process singleton, so any
    // race is internal to that singleton (already serialized).
    const { data: existing, error: selErr } = await this.supabase
      .from('walletconnect_kv')
      .select('key')
      .eq('key', key)
      .maybeSingle();
    if (selErr) throw selErr;
    const now = new Date().toISOString();
    const stored = encodeValue(value);
    if (existing) {
      const { error: updErr } = await this.supabase
        .from('walletconnect_kv')
        .update({ value: stored, updated_at: now })
        .eq('key', key);
      if (updErr) throw updErr;
    } else {
      const { error: insErr } = await this.supabase
        .from('walletconnect_kv')
        .insert({ key, value: stored, updated_at: now });
      if (insErr) throw insErr;
    }
  }

  async removeItem(key: string): Promise<void> {
    const { error } = await this.supabase
      .from('walletconnect_kv')
      .delete()
      .eq('key', key);
    if (error) throw error;
  }
}
