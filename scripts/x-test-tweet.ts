// One-off: post a single tweet to verify the X wiring end-to-end before
// turning the x-broadcast cron loose. Uses the same postTweet() the
// integration uses, so a success here means the credentials, OAuth signing,
// and app Write permission are all good.
//
// Usage:
//   npm run x-test-tweet                       (posts "ZER0 online.")
//   npm run x-test-tweet -- "custom message"   (posts your own text)
//   tsx --env-file=.env.local scripts/x-test-tweet.ts "hello"
//
// Requires X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET
// in the environment (npm run loads .env.local for you). Ignores
// X_POSTING_ENABLED — this is a deliberate manual post, not the cron.
//
// NOTE: this posts a REAL public tweet from whichever account the access
// token belongs to (@atzer0_BOT if you minted it with `npm run x-auth`).

import { postTweet } from '../src/lib/x/client';

const REQUIRED = [
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET',
] as const;

async function main() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(
      `Missing env var(s): ${missing.join(', ')}\n` +
        'Set them in .env.local first (run `npm run x-auth` to mint the access\n' +
        'token + secret), then re-run.',
    );
    process.exit(1);
  }

  // A timestamp keeps repeat runs from tripping X's duplicate-content rejection.
  const text =
    process.argv.slice(2).join(' ').trim() ||
    `ZER0 online. ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`;

  console.log(`Posting: ${text}\n`);
  const res = await postTweet(text);
  if (res.ok) {
    console.log(`✅ Posted. Tweet id: ${res.id}`);
    console.log(`   https://x.com/i/web/status/${res.id}`);
  } else {
    console.error(`❌ Failed (status ${res.status}): ${res.error}`);
    if (res.status === 403) {
      console.error(
        '\n403 usually means the app lacks Write permission. In the X dev\n' +
          'portal set App permissions to "Read and write", then RE-MINT the\n' +
          'access token (`npm run x-auth`) — tokens issued while read-only stay\n' +
          'read-only.',
      );
    } else if (res.status === 401) {
      console.error(
        '\n401 means the signature/credentials were rejected. Double-check the\n' +
          'four X_* values were copied exactly (no trailing spaces).',
      );
    }
    process.exit(1);
  }
}

void main();
