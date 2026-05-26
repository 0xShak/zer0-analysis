// One-off: mint @atzer0_BOT's OAuth 1.0a user Access Token + Secret via the
// PIN (out-of-band) 3-legged flow, so ZER0 tweets from the persona — not from
// the @0xAhrii developer account the portal's "Generate" button would give.
//
// Usage:
//   1. Put the app's consumer credentials in .env.local first:
//        X_API_KEY=<consumer key>
//        X_API_SECRET=<consumer key secret>
//   2. In the X dev portal → your app → "User authentication settings":
//        - App permissions: Read and write
//        - Type of App: Web App / Automated App or Bot
//        - Callback URI: http://localhost/callback   (any value; PIN flow
//          ignores it, but X refuses request_token if none is registered)
//        - Website URL: anything valid
//   3. Run it and follow the prompts:
//        npm run x-auth      (or: tsx --env-file=.env.local scripts/x-oauth-pin.ts)
//      Open the printed URL **while logged in to X as @atzer0_BOT**, approve,
//      paste the PIN. It prints the two values to add to .env.local.
//
// Reuses the signing in src/lib/x/client.ts (the same code the integration
// posts with, and the code the OAuth-vector test pins), so a token minted here
// is signed identically to how it'll be used.

import { createInterface } from 'node:readline/promises';
import crypto from 'node:crypto';
import { oauthSignature, rfc3986 } from '../src/lib/x/client';

const API_KEY = process.env.X_API_KEY;
const API_SECRET = process.env.X_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error(
    'Missing X_API_KEY / X_API_SECRET. Add the app consumer key + secret to\n' +
      '.env.local, then re-run (npm run x-auth loads .env.local for you).',
  );
  process.exit(1);
}

// Build a full OAuth 1.0a Authorization header for a request with no body and
// no query string — all params (oauth_* plus any extras like oauth_callback /
// oauth_verifier) go in the header and are signed.
function authHeader(
  method: string,
  url: string,
  extra: Record<string, string>,
  tokenSecret: string,
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: API_KEY!,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
    ...extra,
  };
  const sig = oauthSignature(method, url, oauth, API_SECRET!, tokenSecret);
  const header: Record<string, string> = { ...oauth, oauth_signature: sig };
  return (
    'OAuth ' +
    Object.keys(header)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(header[k])}"`)
      .join(', ')
  );
}

async function postForm(url: string, header: string): Promise<URLSearchParams> {
  const resp = await fetch(url, { method: 'POST', headers: { Authorization: header } });
  const body = await resp.text();
  if (!resp.ok) {
    console.error(`\n${url} failed (${resp.status}):\n${body}\n`);
    if (/callback/i.test(body)) {
      console.error(
        'Hint: register a Callback URI under the app\'s User authentication\n' +
          'settings (any value) — X rejects request_token without one.\n',
      );
    }
    process.exit(1);
  }
  return new URLSearchParams(body);
}

async function main() {
  const REQUEST_URL = 'https://api.twitter.com/oauth/request_token';
  const AUTHORIZE_URL = 'https://api.twitter.com/oauth/authorize';
  const ACCESS_URL = 'https://api.twitter.com/oauth/access_token';

  // Step 1 — temporary request token (oob = PIN flow).
  const reqParams = await postForm(
    REQUEST_URL,
    authHeader('POST', REQUEST_URL, { oauth_callback: 'oob' }, ''),
  );
  const requestToken = reqParams.get('oauth_token');
  const requestSecret = reqParams.get('oauth_token_secret');
  if (!requestToken || !requestSecret) {
    console.error('No request token in response.');
    process.exit(1);
  }

  // Step 2 — user authorizes (must be logged in as @atzer0_BOT).
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('1. Open this URL in a browser logged in to X as @atzer0_BOT:\n');
  console.log(`   ${AUTHORIZE_URL}?oauth_token=${requestToken}\n`);
  console.log('2. Click "Authorize app", then copy the PIN it shows.');
  console.log('──────────────────────────────────────────────────────────\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pin = (await rl.question('Enter PIN: ')).trim();
  rl.close();

  // Step 3 — exchange the verifier (PIN) for the long-lived access token.
  const accParams = await postForm(
    ACCESS_URL,
    authHeader(
      'POST',
      ACCESS_URL,
      { oauth_token: requestToken, oauth_verifier: pin },
      requestSecret,
    ),
  );
  const screenName = accParams.get('screen_name');
  const token = accParams.get('oauth_token');
  const secret = accParams.get('oauth_token_secret');

  console.log(`\n✅ Authorized as @${screenName}`);
  if (screenName && screenName.toLowerCase() !== 'atzer0_bot') {
    console.log(
      `⚠️  That is NOT @atzer0_BOT. Re-run logged in as the persona account,\n` +
        `    or these tweets will post from @${screenName}.`,
    );
  }
  console.log('\nAdd these two lines to .env.local (and your Vercel env):\n');
  console.log(`X_ACCESS_TOKEN=${token}`);
  console.log(`X_ACCESS_TOKEN_SECRET=${secret}\n`);
}

void main();
