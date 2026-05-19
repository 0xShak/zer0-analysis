import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../lib/database.types';

// Wrap every async DB call in try/catch at the call-site. These helpers
// don't catch — the bot's command handlers convert errors into Telegram
// replies. Each helper does exactly one thing.

export async function upsertTelegramUser(
  supabase: SupabaseClient<Database>,
  telegramUserId: number,
  displayName: string | null,
): Promise<string> {
  // Look up first, insert if missing. Postgres upsert via .upsert() with
  // onConflict='telegram_user_id' would be slightly cleaner, but the
  // generated types don't currently expose that path nicely for partial rows,
  // so do the simple select+insert.
  const { data: existing, error: selErr } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing.id;

  const { data: inserted, error: insErr } = await supabase
    .from('users')
    .insert({
      telegram_user_id: telegramUserId,
      display_name: displayName,
    })
    .select('id')
    .single();
  if (insErr || !inserted) throw insErr ?? new Error('user insert failed');
  return inserted.id;
}

export async function getOrCreateTelegramSession(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<string> {
  const { data: existing, error: selErr } = await supabase
    .from('sessions')
    .select('id')
    .eq('user_id', userId)
    .eq('channel', 'telegram')
    .order('created_at', { ascending: false })
    .limit(1);
  if (selErr) throw selErr;
  if (existing && existing.length > 0) return existing[0].id;

  const { data: created, error: insErr } = await supabase
    .from('sessions')
    .insert({ user_id: userId, channel: 'telegram' })
    .select('id')
    .single();
  if (insErr || !created) throw insErr ?? new Error('session insert failed');
  return created.id;
}

export type LinkResult =
  | { ok: true; linkedUserId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_used' | 'no_user' };

// Single-use consumption of a link code. Atomic-ish: we re-read the row
// under the same update so a second concurrent /link call lands on
// already_used. Postgres' default read-committed isolation is fine here
// because the UPDATE itself acts as the lock — the second update will find
// consumed_at already set and update 0 rows.
export async function consumeLinkCode(
  supabase: SupabaseClient<Database>,
  code: string,
  telegramUserId: string,
): Promise<LinkResult> {
  const nowIso = new Date().toISOString();
  const { data: row, error: selErr } = await supabase
    .from('link_codes')
    .select('code, user_id, session_id, expires_at, consumed_at')
    .eq('code', code)
    .maybeSingle();
  if (selErr) throw selErr;
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.consumed_at) return { ok: false, reason: 'already_used' };
  if (row.expires_at < nowIso) return { ok: false, reason: 'expired' };
  if (!row.user_id) return { ok: false, reason: 'no_user' };

  // Claim the code, but only if it is still unconsumed. Postgres returns the
  // row count via `count` so we can detect a race.
  const { data: claimed, error: updErr } = await supabase
    .from('link_codes')
    .update({ consumed_at: nowIso })
    .eq('code', code)
    .is('consumed_at', null)
    .select('code')
    .maybeSingle();
  if (updErr) throw updErr;
  if (!claimed) return { ok: false, reason: 'already_used' };

  // Point the Telegram user row at the web user_id by merging the telegram
  // user into the web user. Strategy: keep the WEB user record (it's the one
  // with wallet etc.) and re-parent telegram-only artifacts to it.
  //
  // Re-parent: sessions.user_id, messages.user_id from the telegram user
  // record → web user record. Then delete the telegram-only user row.
  //
  // We could instead keep two user rows linked by a `linked_user_id` column,
  // but the simpler "merge into one" path avoids future joins.
  await supabase
    .from('sessions')
    .update({ user_id: row.user_id })
    .eq('user_id', telegramUserId);
  await supabase
    .from('messages')
    .update({ user_id: row.user_id })
    .eq('user_id', telegramUserId);
  // Move the telegram_user_id onto the surviving web user so future bot
  // messages find it. Only set if the web user doesn't already have one.
  const { data: webUser } = await supabase
    .from('users')
    .select('telegram_user_id')
    .eq('id', row.user_id)
    .maybeSingle();
  if (webUser && webUser.telegram_user_id === null) {
    const { data: tgUser } = await supabase
      .from('users')
      .select('telegram_user_id')
      .eq('id', telegramUserId)
      .maybeSingle();
    if (tgUser?.telegram_user_id) {
      // Null out on the temp telegram user FIRST so the unique constraint
      // doesn't fire when we set the same value on the web user.
      await supabase
        .from('users')
        .update({ telegram_user_id: null })
        .eq('id', telegramUserId);
      await supabase
        .from('users')
        .update({ telegram_user_id: tgUser.telegram_user_id })
        .eq('id', row.user_id);
    }
  }
  // Best-effort cleanup of the now-empty telegram user row.
  await supabase.from('users').delete().eq('id', telegramUserId);

  return { ok: true, linkedUserId: row.user_id };
}
