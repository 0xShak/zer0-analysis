// Read-only preview of what the mention-respond cron WOULD do on its next tick
// — without posting anything. Run this before flipping X_MENTIONS_ENABLED=true
// so you can (a) confirm GET /2/users/:id/mentions actually works on your X API
// tier and (b) eyeball the grounded replies before any go out for real.
//
//   npm run x-mentions-dry-run
//   (or: tsx --env-file=.env.local scripts/x-mentions-dry-run.ts)
//
// Mirrors the silence-gate + compose logic in
// src/lib/inngest/functions/x-mentions.ts, minus the cursor/claim/postTweet.
// Requires the four X_* vars (same as x-test-tweet) plus X_BOT_USER_ID.

import { getMentions } from '../src/lib/x/client';
import { composeMentionTweet, stripMentionNoise } from '../src/lib/x/compose';
import { lookupLiveMarkets, significantTokens } from '../src/lib/chat/market-lookup';

const minOverlap = parseInt(process.env.X_MENTION_MIN_OVERLAP ?? '2', 10);

async function main() {
  const userId = process.env.X_BOT_USER_ID;
  if (!userId) {
    console.error(
      'Missing X_BOT_USER_ID. Add it to .env.local (run `npm run x-whoami` to\n' +
        'get the value), then re-run.',
    );
    process.exit(1);
  }

  console.log('── x-mentions dry run ───────────────────────────────────────');
  console.log('X_BOT_USER_ID       :', userId);
  console.log('X_MENTIONS_ENABLED  :', process.env.X_MENTIONS_ENABLED ?? '(unset → cron no-op)');
  console.log('reply cap / hr      :', process.env.X_MENTION_REPLY_CAP ?? '5');
  console.log('min token overlap   :', minOverlap);
  console.log('');

  // No since_id → fetch the most recent mentions, the best preview sample.
  const res = await getMentions(userId);
  if (!res.ok) {
    console.error(`❌ getMentions failed (status ${res.status}): ${res.error}`);
    if (res.status === 403) {
      console.error(
        '\n403 on /mentions usually means your X API tier does not include the\n' +
          'mentions timeline (it needs Basic+, unlike /users/me which is Free).\n' +
          'This is an access-tier limit, not a code bug — the cron logs and\n' +
          'no-ops safely until the tier allows it.',
      );
    }
    process.exit(1);
  }

  console.log(`Fetched ${res.mentions.length} recent mention(s). newest_id=${res.newestId}\n`);

  let wouldReply = 0;
  let wouldSkip = 0;
  // Oldest-first, matching the cron's chronological order.
  for (const m of [...res.mentions].reverse()) {
    const clean = stripMentionNoise(m.text);
    const markets = await lookupLiveMarkets(clean, { minOverlap });
    if (markets.length === 0) {
      wouldSkip += 1;
      console.log(`SKIP (ungrounded)  @${m.authorUsername ?? m.authorId}: ${m.text.slice(0, 80)}`);
      continue;
    }
    const reply = await composeMentionTweet({ question: clean, markets });
    wouldReply += 1;
    const hay = markets[0].question.toLowerCase();
    const matched = significantTokens(clean).filter((t) => hay.includes(t));
    console.log(`REPLY              @${m.authorUsername ?? m.authorId}: ${m.text.slice(0, 80)}`);
    console.log(`   grounded on     : "${markets[0].question.slice(0, 70)}"`);
    console.log(`   matched tokens  : [${matched.join(', ')}]`);
    console.log(`   → would post    : ${reply}`);
    console.log('');
  }

  console.log('─────────────────────────────────────────────────────────────');
  console.log(`Would reply to ${wouldReply}, stay silent on ${wouldSkip}.`);
  console.log('(dry run — nothing was posted)');
}

void main();
