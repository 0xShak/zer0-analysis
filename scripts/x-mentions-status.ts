// Dumps the latest x_mentions rows + the cursor, so you can see what the
// mention-respond cron decided on its last run (replied / skipped_ungrounded /
// rate_capped) without digging in Supabase.
//
//   npm run x-mentions-status

import { createAdminClient } from '../src/lib/supabase/admin';

async function main() {
  const s = createAdminClient();

  const { data: cursor } = await s
    .from('x_mention_cursor')
    .select('since_id, updated_at')
    .eq('id', 1)
    .single();
  console.log('cursor since_id :', cursor?.since_id ?? '(null)');
  console.log('cursor updated  :', cursor?.updated_at ?? '(never)');

  const { data: rows, error } = await s
    .from('x_mentions')
    .select('mention_id, author, text, status, reply_id, created_at')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) {
    console.error('query failed:', error.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.log('\n(no x_mentions rows yet — the cron has not recorded any mention)');
    return;
  }

  const tally = new Map<string, number>();
  for (const r of rows) tally.set(r.status, (tally.get(r.status) ?? 0) + 1);
  console.log('\nstatus tally    :', [...tally].map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('');
  for (const r of rows) {
    console.log(`[${r.status}] @${r.author}  id=${r.mention_id}${r.reply_id ? `  reply=${r.reply_id}` : ''}`);
    console.log(`   ${(r.text ?? '').replace(/\s+/g, ' ').slice(0, 100)}`);
  }
}
void main();
