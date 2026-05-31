// Step 0 of the mention-respond build: verify READ access with the existing
// tokens and grab @atzer0_BOT's numeric id for X_BOT_USER_ID.
//
// One GET /2/users/me signed with the SAME OAuth 1.0a code postTweet() uses
// (oauthSignature + rfc3986 from src/lib/x/client.ts), so a 200 here means the
// tokens already have read scope — no re-mint, no new creds. The numeric id it
// prints is what every /2/users/:id/mentions call in later steps needs.
//
// Usage:
//   npm run x-whoami
//   (or: tsx --env-file=.env.local scripts/x-whoami.ts)
//
// Requires the same four vars as x-test-tweet: X_API_KEY / X_API_SECRET /
// X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET (npm run loads .env.local for you).

import crypto from 'node:crypto';
import { oauthSignature, rfc3986 } from '../src/lib/x/client';

const REQUIRED = [
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET',
] as const;

const ME_URL = 'https://api.twitter.com/2/users/me';

// GET with no query params: the only signed params are the oauth_* set, so the
// base string matches postTweet()'s exactly aside from the GET/POST verb.
function authHeader(method: string, url: string): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: process.env.X_API_KEY!,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.X_ACCESS_TOKEN!,
    oauth_version: '1.0',
  };
  const signature = oauthSignature(
    method,
    url,
    oauth,
    process.env.X_API_SECRET!,
    process.env.X_ACCESS_TOKEN_SECRET!,
  );
  const header: Record<string, string> = { ...oauth, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(header)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(header[k])}"`)
      .join(', ')
  );
}

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

  const resp = await fetch(ME_URL, {
    method: 'GET',
    headers: { Authorization: authHeader('GET', ME_URL) },
  });
  const body = await resp.text();

  if (!resp.ok) {
    console.error(`❌ GET /2/users/me failed (status ${resp.status}): ${body.slice(0, 500)}`);
    if (resp.status === 403) {
      console.error(
        '\n403 on a READ call is unusual — your write test passed, so the token\n' +
          'has scope. Check the app is still attached to a Project (v2 endpoints\n' +
          'require Project access, not just a standalone app).',
      );
    } else if (resp.status === 401) {
      console.error(
        '\n401 = signature/credentials. Re-check the four X_* values for typos or\n' +
          'trailing whitespace.',
      );
    }
    process.exit(1);
  }

  const json = JSON.parse(body) as { data?: { id?: string; name?: string; username?: string } };
  const { id, name, username } = json.data ?? {};
  console.log(`✅ Read access OK. Authenticated as @${username} (${name})`);
  console.log('\nAdd this line to .env.local (and your Vercel env):\n');
  console.log(`X_BOT_USER_ID=${id}`);
}

void main();
