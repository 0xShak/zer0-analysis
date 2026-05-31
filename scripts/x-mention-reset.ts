// Re-arms the mention-respond cron to reprocess recent mentions, for testing.
// Sets the cursor's since_id and DELETES x_mentions rows newer than it (so they
// aren't treated as already-decided). The cron will re-fetch + reprocess them
// on its next run.
//
//   npm run x-mention-reset -- <since_id>   set cursor to <since_id>, delete newer rows
//   npm run x-mention-reset -- null         clear cursor (re-fetch most recent ~25)
//
// Example: to replay the Switzerland question (id 2061047904379207874), pass the
// id just before it so the cron re-fetches from there.

import { createAdminClient } from '../src/lib/supabase/admin';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    const s = createAdminClient();
    const { data } = await s.from('x_mention_cursor').select('since_id').eq('id', 1).single();
    console.error(
      `Usage: npm run x-mention-reset -- <since_id | null>\n` +
        `Current cursor since_id: ${data?.since_id ?? '(null)'}`,
    );
    process.exit(1);
  }
  const sinceId = arg === 'null' ? null : arg;
  const s = createAdminClient();

  // Delete rows that would otherwise be treated as already-decided on re-fetch.
  const del = s.from('x_mentions').delete({ count: 'exact' });
  const { count } = sinceId
    ? await del.gt('mention_id', sinceId)
    : await del.neq('mention_id', '');

  const { error } = await s
    .from('x_mention_cursor')
    .update({ since_id: sinceId, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) {
    console.error('cursor update failed:', error.message);
    process.exit(1);
  }

  console.log(`Cursor since_id set to: ${sinceId ?? '(null)'}`);
  console.log(`Deleted x_mentions rows: ${count ?? 0}`);
  console.log('Next cron run (or manual Invoke) will reprocess from here.');
}
void main();
